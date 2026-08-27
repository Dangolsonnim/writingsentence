/**
 * 세션 패키지(zip: manifest.json / export.json / events.jsonl / images/) —
 * SessionPackageExporter.kt 구조 동일 + 업로드 큐(IndexedDB, 백그라운드 재시도).
 * 업로드 프로토콜: POST <functionUrl> (application/zip),
 * 헤더 x-classroom-upload-token / x-session-package-name — SupabaseUploadWorker.kt 동일.
 */
import { zipSync } from 'fflate';
import { del, get, getAll, put } from './db';
import {
  APP_VERSION,
  listSessionData,
  logEvent,
  newId,
  type ParticipantRow,
  type SessionRow,
} from './logger';

export interface UploadRow {
  upload_id: string;
  session_id: string;
  participant_id: string;
  package_name: string;
  status: string; // pending | uploading | uploaded | failed
  attempt_count: number;
  last_attempt_at: number | null;
  uploaded_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  blob: Blob;
}

export interface UploadConfig {
  functionUrl: string;
  token: string;
}

const SETTINGS_KEY = 'upload_config';

export async function getUploadConfig(): Promise<UploadConfig> {
  const row = await get<{ key: string; value: UploadConfig }>('settings', SETTINGS_KEY);
  return (
    row?.value ?? {
      functionUrl: 'https://wdjovodhalidiqhlojvj.supabase.co/functions/v1/classroom-upload',
      token: '',
    }
  );
}

export async function setUploadConfig(cfg: UploadConfig): Promise<void> {
  await put('settings', { key: SETTINGS_KEY, value: cfg });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await get<{ key: string; value: T }>('settings', key);
  return row?.value ?? fallback;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await put('settings', { key, value });
}

/** 세션 → zip 패키지 생성 + 업로드 큐 등록 */
export async function exportSessionPackage(
  session: SessionRow,
  participant: ParticipantRow
): Promise<UploadRow> {
  const { attempts, events, assets } = await listSessionData(session.session_id);

  const manifest = {
    schemaVersion: 1,
    app: { platform: 'web', appVersion: APP_VERSION, buildNumber: session.build_number ?? 'dev' },
    participant: {
      participantId: session.participant_id,
      classId: session.class_id,
      schoolCode: session.school_code,
      grade: session.grade,
      groupType: session.group_type,
    },
    session: {
      sessionId: session.session_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      contentType: session.content_type,
      templateId: session.template_id,
    },
    counts: {
      problemAttempts: 0,
      programRevisions: 0,
      noteAttempts: attempts.length,
      programExecutions: 0,
      eventLogs: events.length,
      fileAssets: assets.length,
    },
    files: { dbExport: 'export.json', events: 'events.jsonl', imagesDir: 'images/' },
  };

  const assetsMeta = assets.map((a, index) => ({
    file_asset_id: a.file_asset_id,
    session_id: a.session_id,
    note_attempt_id: a.note_attempt_id,
    asset_type: a.asset_type,
    mime_type: a.mime_type,
    file_size_bytes: a.file_size_bytes,
    sha256: a.sha256,
    width: a.width,
    height: a.height,
    slot_index: a.slot_index,
    created_at: a.created_at,
    upload_status: a.upload_status,
    zip_entry: `images/${a.asset_type}_${index + 1}.png`,
  }));

  const exportJson = {
    schemaVersion: 1,
    participants: [participant],
    studySessions: [session],
    dictationAttempts: attempts,
    fileAssets: assetsMeta,
    eventLogs: events,
  };

  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    'manifest.json': enc.encode(JSON.stringify(manifest)),
    'export.json': enc.encode(JSON.stringify(exportJson)),
    'events.jsonl': enc.encode(events.map((e) => JSON.stringify(e)).join('\n') + '\n'),
  };
  for (let i = 0; i < assets.length; i++) {
    const buf = new Uint8Array(await assets[i].blob.arrayBuffer());
    files[assetsMeta[i].zip_entry] = buf;
  }
  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });

  const now = Date.now();
  const upload: UploadRow = {
    upload_id: newId('upload'),
    session_id: session.session_id,
    participant_id: session.participant_id,
    package_name: `${session.session_id}.zip`,
    status: 'pending',
    attempt_count: 0,
    last_attempt_at: null,
    uploaded_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    blob,
  };
  // 같은 세션의 이전 패키지는 대체(최신만 유지)
  const existing = (await getAll<UploadRow>('uploads')).filter(
    (u) => u.session_id === session.session_id && u.status !== 'uploaded'
  );
  for (const e of existing) await del('uploads', e.upload_id);
  await put('uploads', upload);
  await logEvent('upload_package_created', {
    sessionId: session.session_id,
    participantId: session.participant_id,
    source: 'sync',
    payload: { uploadId: upload.upload_id, sizeBytes: blob.size },
  });
  return upload;
}

let uploaderTimer: number | null = null;
let uploading = false;

/** 백그라운드 업로드 루프 시작 — 온라인 복귀·주기 재시도 */
export function startUploader(intervalMs = 30000): void {
  if (uploaderTimer !== null) return;
  const kick = () => void processUploadQueue();
  window.addEventListener('online', kick);
  uploaderTimer = window.setInterval(kick, intervalMs);
  kick();
}

export async function listUploads(): Promise<UploadRow[]> {
  const rows = await getAll<UploadRow>('uploads');
  rows.sort((a, b) => b.created_at - a.created_at);
  return rows;
}

export async function processUploadQueue(): Promise<void> {
  if (uploading || !navigator.onLine) return;
  uploading = true;
  try {
    const cfg = await getUploadConfig();
    if (!cfg.functionUrl || !cfg.token) return; // 토큰 미설정 — 보류
    const pending = (await getAll<UploadRow>('uploads')).filter(
      (u) => u.status === 'pending' || u.status === 'failed'
    );
    for (const pkg of pending) {
      const now = Date.now();
      pkg.status = 'uploading';
      pkg.updated_at = now;
      await put('uploads', pkg);
      try {
        const res = await fetch(cfg.functionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/zip',
            'x-classroom-upload-token': cfg.token,
            'x-session-package-name': pkg.package_name,
          },
          body: pkg.blob,
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        pkg.status = 'uploaded';
        pkg.uploaded_at = Date.now();
        pkg.attempt_count += 1;
        pkg.last_attempt_at = now;
        pkg.last_error = null;
        pkg.updated_at = Date.now();
        await put('uploads', pkg);
        await logEvent('sync_completed', {
          sessionId: pkg.session_id,
          participantId: pkg.participant_id,
          source: 'sync',
          payload: { uploadId: pkg.upload_id, httpStatus: res.status },
        });
      } catch (e) {
        pkg.status = 'failed';
        pkg.attempt_count += 1;
        pkg.last_attempt_at = now;
        pkg.last_error = e instanceof Error ? e.message : String(e);
        pkg.updated_at = Date.now();
        await put('uploads', pkg);
        await logEvent('sync_failed', {
          sessionId: pkg.session_id,
          participantId: pkg.participant_id,
          source: 'sync',
          severity: 'error',
          message: pkg.last_error,
          payload: { uploadId: pkg.upload_id, attemptCount: pkg.attempt_count },
        });
      }
    }
  } finally {
    uploading = false;
  }
}
