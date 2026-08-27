/**
 * 연구 로그 — 로봇 앱 세션 패키지 스키마(ResearchEntities/SessionPackageExporter)와
 * 필드명 호환 + 받아쓰기 신설 필드(지시문 §6).
 * 통과·거부 무관 전 칸 gate_grade·gate_score 기록.
 */
import { get, getAllByIndex, put } from './db';

export const APP_VERSION = 'dictweb1';
export const GATE_MODEL_VERSION = 'v1';
export const OCR_SERVICE = 'onnx_crnn_web';

export type ClassGroup = 'A' | 'B';
export const GATE_PASS_THRESHOLD: Record<ClassGroup, number> = { A: 4, B: 3 };

export interface ParticipantRow {
  participant_id: string;
  class_id: string;
  school_code: string;
  grade: number;
  group_type: string; // class_group A/B
  student_number_hash: string | null;
  created_at: number;
  app_install_id: string | null;
  metadata_json: string | null;
}

export interface SessionRow {
  session_id: string;
  participant_id: string;
  class_id: string;
  school_code: string;
  grade: number;
  group_type: string;
  started_at: number;
  ended_at: number | null;
  session_status: string;
  app_version: string;
  build_number: string | null;
  platform: string;
  device_model: string;
  android_version: string;
  screen_width: number | null;
  screen_height: number | null;
  network_type: string | null;
  upload_status: string;
  created_at: number;
  updated_at: number;
  // 신설
  content_type: string;
  template_id: string;
  class_group: string;
  gate_pass_threshold: number;
  gate_model_version: string;
  verify_tau1: number;
  verify_tau2: number;
}

export interface AttemptRow {
  note_attempt_id: string;
  session_id: string;
  participant_id: string;
  slot_index: number;
  slot_id: string;
  is_blank: boolean;
  skipped_before_ocr: boolean;
  blank_source: string | null;
  local_blank: boolean | null;
  blank_score: number | null;
  blank_reason: string | null;
  dark_ratio: number | null;
  ink_ratio: number | null;
  std_dev: number | null;
  component_count: number | null;
  largest_component_area: number | null;
  crop_asset_id: string | null;
  crop_width: number | null;
  crop_height: number | null;
  crop_sha256: string | null;
  ocr_started_at: number | null;
  ocr_completed_at: number | null;
  ocr_success: boolean | null;
  ocr_service: string | null;
  ocr_model_version: string | null;
  ocr_raw_text: string | null;
  ocr_normalized_text: string | null;
  ocr_confidence: number | null;
  gate_score: number | null;
  gate_grade: number | null;
  gate_decision: string | null;
  gate_threshold: number | null;
  gate_model_version: string | null;
  created_at: number;
  updated_at: number;
  // ── 받아쓰기 신설 (지시문 §6) ──
  content_type: string; // "dictation"
  template_id: string;
  word_id: string;
  target_word: string;
  gate_pass_threshold: number;
  class_group: string;
  jamo_edit_distance: number | null;
  wrong_jamo_positions: string | null; // JSON
  spelling_correct: boolean | null;
  // ── 철자 검증 모드 (지시문 §3, 2026-08-27 도메인 평가 확정) ──
  verify_margin: number | null; // 강제 정렬 여유도 M (전 판정 칸 기록)
  verify_decision: string | null; // correct | unclear | wrong
  verify_tau1: number | null;
  verify_tau2: number | null;
  estimated_written: string | null; // 오답 확정 시 1-자모 이웃 추정 낱말
  reward_level: number; // 0/3/4/5
  retry_index: number;
  escape_used: boolean;
  app_version: string;
  judge_status: string;
  feedback_message: string | null;
  marker_detail: string | null;
  scan_duration_ms: number | null;
  gate_duration_ms: number | null;
  ocr_duration_ms: number | null;
}

export interface EventRow {
  event_id: string;
  session_id: string | null;
  participant_id: string | null;
  note_attempt_id: string | null;
  event_type: string;
  event_time: number;
  local_sequence: number;
  severity: string;
  source: string;
  message: string | null;
  payload_json: string;
  app_version: string;
  created_at: number;
}

export interface AssetRow {
  file_asset_id: string;
  session_id: string;
  note_attempt_id: string | null;
  asset_type: string;
  mime_type: string;
  file_size_bytes: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  slot_index: number | null;
  created_at: number;
  upload_status: string;
  blob: Blob;
}

let seq = 0;

export function newId(prefix: string): string {
  const rnd =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rnd}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 가명 participant_id — 학급 코드+학생 번호에서 유도(원문 번호는 저장하지 않음).
 *  연구 측 코드 규칙 제공 시 이 함수만 교체. */
export async function deriveParticipantId(classCode: string, studentNumber: string): Promise<{
  participantId: string;
  studentNumberHash: string;
}> {
  const enc = new TextEncoder();
  const hash = await sha256Hex(enc.encode(`${classCode}:${studentNumber}:${APP_VERSION}`).buffer as ArrayBuffer);
  return {
    participantId: `dict-${classCode}-${hash.slice(0, 8)}`,
    studentNumberHash: hash,
  };
}

export async function saveParticipant(row: ParticipantRow): Promise<void> {
  await put('participants', row);
}

export async function saveSession(row: SessionRow): Promise<void> {
  await put('sessions', row);
}

export async function saveAttempt(row: AttemptRow): Promise<void> {
  await put('attempts', row);
}

export async function saveAsset(row: AssetRow): Promise<void> {
  await put('assets', row);
}

export async function logEvent(
  eventType: string,
  opts: {
    sessionId?: string | null;
    participantId?: string | null;
    noteAttemptId?: string | null;
    severity?: string;
    source?: string;
    message?: string | null;
    payload?: Record<string, unknown>;
  } = {}
): Promise<void> {
  const now = Date.now();
  const row: EventRow = {
    event_id: newId('evt'),
    session_id: opts.sessionId ?? null,
    participant_id: opts.participantId ?? null,
    note_attempt_id: opts.noteAttemptId ?? null,
    event_type: eventType,
    event_time: now,
    local_sequence: seq++,
    severity: opts.severity ?? 'info',
    source: opts.source ?? 'app',
    message: opts.message ?? null,
    payload_json: JSON.stringify(opts.payload ?? {}),
    app_version: APP_VERSION,
    created_at: now,
  };
  await put('events', row);
}

export async function getSession(sessionId: string): Promise<SessionRow | undefined> {
  return get<SessionRow>('sessions', sessionId);
}

/** 최근 시도 N건 + 크롭 asset (진단 화면용) */
export async function listRecentAttempts(
  limit: number
): Promise<Array<{ attempt: AttemptRow; asset: AssetRow | null }>> {
  const { getAll } = await import('./db');
  const attempts = await getAll<AttemptRow>('attempts');
  attempts.sort((a, b) => b.created_at - a.created_at);
  const recent = attempts.slice(0, limit);
  const assets = await getAll<AssetRow>('assets');
  const byAttempt = new Map(assets.map((a) => [a.note_attempt_id, a]));
  return recent.map((attempt) => ({
    attempt,
    asset: byAttempt.get(attempt.note_attempt_id) ?? null,
  }));
}

export async function listSessionData(sessionId: string): Promise<{
  attempts: AttemptRow[];
  events: EventRow[];
  assets: AssetRow[];
}> {
  const [attempts, events, assets] = await Promise.all([
    getAllByIndex<AttemptRow>('attempts', 'session_id', sessionId),
    getAllByIndex<EventRow>('events', 'session_id', sessionId),
    getAllByIndex<AssetRow>('assets', 'session_id', sessionId),
  ]);
  attempts.sort((a, b) => a.created_at - b.created_at);
  events.sort((a, b) => a.local_sequence - b.local_sequence);
  return { attempts, events, assets };
}
