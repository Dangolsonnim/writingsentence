/**
 * 받아쓰기 웹앱 메인 흐름 — 웹판 v2 (사용자 확정 2026-08-27):
 * 로그인 → 차시 선택 → 그림 단서 4개 소개 → 학생이 학습지 4칸을 모두 쓴 뒤
 * [전체 촬영] → 4칸 일괄 판정(게이트만; 철자는 로그용) → 라이브 카메라 AR로
 * 통과 낱말 3D 실체화(등급 3/4/5 연동) + "멋진 글자예요!" 말풍선, 미달 낱말은
 * "좀 더 바르게 써볼까요?" 말풍선 → 고쳐 쓰고 재촬영(통과 상태 유지) →
 * 전원 통과 → 모아 보기 → 종료. 점수/랭킹/타이머 UI 없음.
 */
import { loadEngines, type Engines } from './core/engines';
import { judgeSheet, type SheetJudgeResult, type SlotJudgeResult } from './core/pipeline';
import type { Raster } from './core/raster';
import { initCv } from './core/vision';
import { loadAllTemplates, type DictTemplate } from './core/worksheet';
import {
  APP_VERSION,
  GATE_MODEL_VERSION,
  GATE_PASS_THRESHOLD,
  OCR_SERVICE,
  deriveParticipantId,
  logEvent,
  newId,
  saveAsset,
  saveAttempt,
  saveParticipant,
  saveSession,
  sha256Hex,
  type AttemptRow,
  type ClassGroup,
  type ParticipantRow,
  type SessionRow,
} from './logging/logger';
import {
  exportSessionPackage,
  getSetting,
  getUploadConfig,
  listUploads,
  processUploadQueue,
  setSetting,
  setUploadConfig,
  startUploader,
} from './logging/packager';
import { cueStill, playCollection, type RewardHandle } from './three/stage';
import { LiveArView, type ArSlotDisplay } from './ui/live_ar';

const DEFAULT_PIN = '7391';
const ESCAPE_AFTER_REJECTS = 3; // 같은 낱말 REJECT 3회 → 다음 촬영부터 override

interface WordProgress {
  passed: boolean;
  rewardLevel: number;
  gateRejects: number;
  escapeUsed: boolean;
}

interface AppState {
  root: HTMLElement;
  engines: Engines | null;
  templates: DictTemplate[];
  classGroup: ClassGroup;
  participant: ParticipantRow | null;
  session: SessionRow | null;
  template: DictTemplate | null;
  words: WordProgress[];
  captureIndex: number; // 촬영 회차 (0부터)
  stage: RewardHandle | null;
  ar: LiveArView | null;
}

const state: AppState = {
  root: document.createElement('div'),
  engines: null,
  templates: [],
  classGroup: 'B',
  participant: null,
  session: null,
  template: null,
  words: [],
  captureIndex: -1,
  stage: null,
  ar: null,
};

export async function startApp(root: HTMLElement): Promise<void> {
  state.root = root;
  showOverlay('준비 중이에요…');
  state.classGroup = (await getSetting<ClassGroup>('class_group', 'B')) as ClassGroup;
  const [templates] = await Promise.all([loadAllTemplates(import.meta.env.BASE_URL), initCv()]);
  state.templates = templates;
  state.engines = await loadEngines((msg) => showOverlay(msg));
  hideOverlay();
  startUploader();
  exposeDevHooks();
  renderLogin();
}

/* ───────── 공통 UI 유틸 ───────── */

function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function setScreen(el: HTMLElement): void {
  stopStage();
  stopAr();
  state.root.innerHTML = '';
  state.root.appendChild(el);
}

let overlayEl: HTMLElement | null = null;
function showOverlay(msg: string): void {
  if (!overlayEl) {
    overlayEl = h(`<div class="overlay"><div class="spinner"></div><div class="ov-msg"></div></div>`);
    document.body.appendChild(overlayEl);
  }
  overlayEl.querySelector('.ov-msg')!.textContent = msg;
}
function hideOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
}

function stopStage(): void {
  state.stage?.stop();
  state.stage = null;
  document.querySelector('.stage-wrap')?.remove();
}

function stopAr(): void {
  state.ar?.stop();
  state.ar = null;
}

/* ───────── 로그인 ───────── */

function renderLogin(): void {
  const el = h(`
    <div class="screen">
      <button class="gear" title="교사 설정">⚙️</button>
      <h1>받아쓰기 놀이터</h1>
      <div class="card">
        <div class="field"><label>학급 코드</label><input id="class-code" inputmode="text" autocomplete="off" placeholder="예: KNU1" /></div>
        <div class="field"><label>내 번호</label><input id="student-no" inputmode="numeric" autocomplete="off" placeholder="예: 7" /></div>
        <button class="big-btn" id="btn-start">시작하기</button>
      </div>
      <p class="muted" style="text-align:center">선생님이 알려 준 학급 코드와 번호를 넣어요.</p>
    </div>`);
  el.querySelector('.gear')!.addEventListener('click', () => void renderSettingsGate());
  el.querySelector('#btn-start')!.addEventListener('click', async () => {
    const classCode = (el.querySelector('#class-code') as HTMLInputElement).value.trim();
    const studentNo = (el.querySelector('#student-no') as HTMLInputElement).value.trim();
    if (!classCode || !studentNo) return;
    showOverlay('들어가는 중…');
    await doLogin(classCode, studentNo);
    hideOverlay();
    renderSessionSelect();
  });
  setScreen(el);
}

async function doLogin(classCode: string, studentNo: string): Promise<void> {
  const { participantId, studentNumberHash } = await deriveParticipantId(classCode, studentNo);
  const now = Date.now();
  state.participant = {
    participant_id: participantId,
    class_id: classCode,
    school_code: '',
    grade: 0,
    group_type: state.classGroup,
    student_number_hash: studentNumberHash,
    created_at: now,
    app_install_id: null,
    metadata_json: JSON.stringify({ content_type: 'dictation' }),
  };
  await saveParticipant(state.participant);
  await logEvent('login', { participantId, payload: { classCode } });
}

/* ───────── 차시 선택 ───────── */

function renderSessionSelect(): void {
  const el = h(`
    <div class="screen">
      <h1>오늘은 몇 차시인가요?</h1>
      <div class="session-pick"></div>
      <button class="big-btn ghost" id="btn-back">처음으로</button>
    </div>`);
  const pick = el.querySelector('.session-pick')!;
  state.templates.forEach((t, i) => {
    const btn = h(
      `<button class="big-btn ${i % 2 ? 'green' : ''}">${t.title}<small>${t.difficulty_focus}</small></button>`
    );
    btn.addEventListener('click', () => void beginSession(t));
    pick.appendChild(btn);
  });
  el.querySelector('#btn-back')!.addEventListener('click', () => renderLogin());
  setScreen(el);
}

async function beginSession(template: DictTemplate): Promise<void> {
  const p = state.participant!;
  const now = Date.now();
  const session: SessionRow = {
    session_id: newId('sess'),
    participant_id: p.participant_id,
    class_id: p.class_id,
    school_code: p.school_code,
    grade: p.grade,
    group_type: state.classGroup,
    started_at: now,
    ended_at: null,
    session_status: 'active',
    app_version: APP_VERSION,
    build_number: null,
    platform: 'web',
    device_model: navigator.userAgent,
    android_version: '',
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    network_type: navigator.onLine ? 'online' : 'offline',
    upload_status: 'pending',
    created_at: now,
    updated_at: now,
    content_type: 'dictation',
    template_id: template.template_id,
    class_group: state.classGroup,
    gate_pass_threshold: GATE_PASS_THRESHOLD[state.classGroup],
    gate_model_version: GATE_MODEL_VERSION,
  };
  state.session = session;
  state.template = template;
  state.captureIndex = -1;
  state.words = template.note_slots.map(() => ({
    passed: false,
    rewardLevel: 0,
    gateRejects: 0,
    escapeUsed: false,
  }));
  await saveSession(session);
  await logEvent('session_started', {
    sessionId: session.session_id,
    participantId: p.participant_id,
    payload: {
      templateId: template.template_id,
      classGroup: state.classGroup,
      gatePassThreshold: session.gate_pass_threshold,
    },
  });
  renderCueIntro();
}

/* ───────── 그림 단서 소개 (시작 시 1회) ───────── */

function renderCueIntro(): void {
  const template = state.template!;
  const el = h(`
    <div class="screen">
      <h1>오늘의 낱말 그림이에요</h1>
      <p class="speech">선생님이 불러 주는 낱말을 잘 듣고,<br/>학습지의 <b>네 칸을 모두</b> 연필로 써 보세요.<br/>다 쓰면 사진을 찍어요!</p>
      <div class="cue-grid"></div>
      <button class="big-btn green" id="btn-go">다 썼어요! 사진 찍기</button>
    </div>`);
  const grid = el.querySelector('.cue-grid')!;
  template.note_slots.forEach((s) => {
    const item = h(`<div class="cue-item"><img alt="그림 단서" /><span>${s.label}번</span></div>`);
    (item.querySelector('img') as HTMLImageElement).src = cueStill(s.scene_key);
    grid.appendChild(item);
  });
  el.querySelector('#btn-go')!.addEventListener('click', () => void renderCapture());
  setScreen(el);
}

/* ───────── 촬영 + 라이브 AR ───────── */

async function renderCapture(): Promise<void> {
  const template = state.template!;
  const el = h(`
    <div class="ar-screen">
      <div class="ar-view"></div>
      <div class="ar-topbar"><span class="ar-status">카메라를 켜는 중…</span></div>
      <div class="ar-actions">
        <div id="sheet-feedback"></div>
        <button class="big-btn green" id="btn-shot" disabled>📷 찰칵!</button>
        <button class="big-btn" id="btn-collect" style="display:none">모아 보기</button>
        <label class="big-btn ghost" id="btn-file" style="display:none">앨범/카메라에서 사진 고르기
          <input class="hidden-input" type="file" accept="image/*" capture="environment" /></label>
      </div>
    </div>`);
  setScreen(el);
  const statusEl = el.querySelector('.ar-status') as HTMLElement;
  const shotBtn = el.querySelector('#btn-shot') as HTMLButtonElement;
  const collectBtn = el.querySelector('#btn-collect') as HTMLButtonElement;
  const fileLabel = el.querySelector('#btn-file') as HTMLElement;
  const fileInput = el.querySelector('input[type=file]') as HTMLInputElement;

  const ar = new LiveArView(el.querySelector('.ar-view') as HTMLElement, template, state.templates);
  state.ar = ar;

  const refreshButtons = () => {
    const allPassed = state.words.every((w) => w.passed);
    collectBtn.style.display = allPassed ? '' : 'none';
    shotBtn.textContent = state.captureIndex >= 0 ? '📷 다시 찍기' : '📷 찰칵!';
  };
  refreshButtons();

  const live = await ar.startCamera();
  if (live) {
    let lastFound = 0;
    ar.onTrack = (found, wrongTemplate) => {
      lastFound = found;
      if (wrongTemplate) {
        statusEl.textContent = '오늘 학습지가 아닌 것 같아요!';
        shotBtn.disabled = true;
      } else if (found === 4) {
        statusEl.textContent = '좋아요! 찰칵을 눌러요';
        shotBtn.disabled = false;
      } else {
        statusEl.textContent = '학습지 네 모서리가 다 보이게 비춰 주세요';
        shotBtn.disabled = true;
      }
    };
    shotBtn.addEventListener('click', async () => {
      if (lastFound < 4) return;
      const frame = ar.captureFrame();
      if (!frame) return;
      await handleCapture(frame, statusEl, refreshButtons);
    });
  } else {
    statusEl.textContent = '카메라를 쓸 수 없어 사진 고르기로 진행해요';
    shotBtn.style.display = 'none';
    fileLabel.style.display = '';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      const raster = await fileToRaster(file);
      await handleCapture(raster, statusEl, refreshButtons, true);
    });
  }

  collectBtn.addEventListener('click', () => void showCollection());
}

async function handleCapture(
  frame: Raster,
  statusEl: HTMLElement,
  refreshButtons: () => void,
  staticMode = false
): Promise<void> {
  const engines = state.engines!;
  const template = state.template!;
  const session = state.session!;
  state.captureIndex += 1;
  showOverlay('낱말을 살펴보고 있어요…');
  try {
    const scaled = downscaleRaster(frame, 2400);
    const passedBefore = new Set(
      template.note_slots.filter((_, i) => state.words[i].passed).map((s) => s.word_id)
    );
    const escapeActiveByWord: Record<string, boolean> = {};
    template.note_slots.forEach((s, i) => {
      escapeActiveByWord[s.word_id] = state.words[i].gateRejects >= ESCAPE_AFTER_REJECTS;
    });
    const result = await judgeSheet(scaled, engines, {
      template,
      gatePassThreshold: session.gate_pass_threshold,
      escapeActiveByWord,
      passedWords: passedBefore,
      allTemplates: state.templates,
    });

    const feedback = document.querySelector('#sheet-feedback');
    if (result.status !== 'ok') {
      hideOverlay();
      const msg =
        result.status === 'wrong_template'
          ? '오늘 학습지가 아닌 것 같아요. 오늘 학습지를 찍어 볼까요?'
          : '학습지가 잘 보이게 다시 찍어 볼까요?';
      if (feedback) feedback.innerHTML = `<div class="feedback warn">${msg}</div>`;
      await recordCapture(result, passedBefore, escapeActiveByWord);
      return;
    }
    if (feedback) feedback.innerHTML = '';

    // 상태 갱신 (통과 누적 유지, 탈출구 카운트)
    const displays: ArSlotDisplay[] = [];
    result.slots.forEach((sr, i) => {
      const w = state.words[i];
      const slot = template.note_slots[i];
      if (sr.status === 'gate_reject') w.gateRejects += 1;
      if (sr.status === 'pass') {
        if (!w.passed) {
          w.passed = true;
          w.escapeUsed = sr.gateDecision === 'override' && escapeActiveByWord[slot.word_id];
        }
        w.rewardLevel = Math.max(w.rewardLevel, sr.rewardLevel);
      }
      displays.push({
        slotIndex: i,
        sceneKey: slot.scene_key,
        rewardLevel: w.passed ? w.rewardLevel : 0,
        passed: w.passed,
        message: bubbleMessage(sr, w, escapeActiveByWord[slot.word_id]),
      });
    });

    await recordCapture(result, passedBefore, escapeActiveByWord);
    hideOverlay();

    if (staticMode && result.homography) {
      state.ar?.showStatic(scaled, result.homography);
    }
    state.ar?.setResults(displays);
    const passCount = state.words.filter((w) => w.passed).length;
    statusEl.textContent =
      passCount === state.words.length
        ? '와, 네 낱말 모두 멋져요!'
        : `멋진 낱말 ${passCount}개! 나머지도 고쳐 써 볼까요?`;
    refreshButtons();
  } catch (e) {
    hideOverlay();
    await logEvent('judge_error', {
      sessionId: session.session_id,
      participantId: session.participant_id,
      severity: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
    statusEl.textContent = '사진을 읽지 못했어요. 다시 찍어 볼까요?';
  }
}

function bubbleMessage(sr: SlotJudgeResult, w: WordProgress, escapeActive: boolean): string {
  if (w.passed) {
    if (sr.gateDecision === 'override' && escapeActive && sr.status === 'pass') {
      return '열심히 썼네요!';
    }
    return '멋진 글자예요!';
  }
  if (sr.status === 'blank') return '여기에 낱말을 써 보세요';
  return '좀 더 바르게 써볼까요?';
}

/* ───────── 유틸: 이미지 ───────── */

function downscaleRaster(r: Raster, maxSide: number): Raster {
  const scale = Math.min(1, maxSide / Math.max(r.width, r.height));
  if (scale >= 1) return r;
  const w = Math.round(r.width * scale);
  const hh = Math.round(r.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = hh;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, hh);
  const img = ctx.getImageData(0, 0, w, hh);
  return { data: img.data, width: w, height: hh };
}

async function fileToRaster(file: Blob, maxSide = 2400): Promise<Raster> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await createImageBitmap(file);
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hh = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, hh);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, hh);
  return { data: img.data, width: w, height: hh };
}

function rasterToCanvas(r: Raster): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return canvas;
}

async function rasterToPngBlob(r: Raster): Promise<Blob> {
  const canvas = rasterToCanvas(r);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png');
  });
}

/* ───────── 로그 기록 ───────── */

async function recordCapture(
  result: SheetJudgeResult,
  passedBefore: Set<string>,
  escapeActiveByWord: Record<string, boolean>
): Promise<void> {
  const session = state.session!;
  const template = state.template!;
  const now = Date.now();

  await logEvent('sheet_captured', {
    sessionId: session.session_id,
    participantId: session.participant_id,
    payload: {
      captureIndex: state.captureIndex,
      status: result.status,
      markerDetail: result.markerDetail,
      scanMs: result.scanMs,
    },
  });
  if (result.status !== 'ok') return;

  for (const sr of result.slots) {
    const slot = template.note_slots[sr.slotIndex];
    const attemptId = newId('note');
    let cropAssetId: string | null = null;
    let cropSha: string | null = null;
    let cropW: number | null = null;
    let cropH: number | null = null;
    if (sr.cropOcrWide) {
      try {
        const blob = await rasterToPngBlob(sr.cropOcrWide);
        cropSha = await sha256Hex(await blob.arrayBuffer());
        cropAssetId = newId('asset');
        cropW = sr.cropOcrWide.width;
        cropH = sr.cropOcrWide.height;
        await saveAsset({
          file_asset_id: cropAssetId,
          session_id: session.session_id,
          note_attempt_id: attemptId,
          asset_type: 'slot_crop',
          mime_type: 'image/png',
          file_size_bytes: blob.size,
          sha256: cropSha,
          width: cropW,
          height: cropH,
          slot_index: sr.slotIndex + 1,
          created_at: now,
          upload_status: 'pending',
          blob,
        });
      } catch {
        // 크롭 저장 실패는 판정을 막지 않음
      }
    }

    const w = state.words[sr.slotIndex];
    const escapeActive = escapeActiveByWord[slot.word_id] === true;
    const row: AttemptRow = {
      note_attempt_id: attemptId,
      session_id: session.session_id,
      participant_id: session.participant_id,
      slot_index: sr.slotIndex + 1,
      slot_id: String(slot.slot_id),
      is_blank: sr.status === 'blank',
      skipped_before_ocr: sr.ocr === null,
      blank_source: sr.blank ? 'local' : null,
      local_blank: sr.blank?.localBlank ?? null,
      blank_score: sr.blank?.blankScore ?? null,
      blank_reason: sr.blank?.blankReason ?? null,
      dark_ratio: sr.blank?.darkRatio ?? null,
      ink_ratio: sr.blank?.inkRatio ?? null,
      std_dev: sr.blank?.stdDev ?? null,
      component_count: sr.blank?.componentCount ?? null,
      largest_component_area: sr.blank?.largestComponentArea ?? null,
      crop_asset_id: cropAssetId,
      crop_width: cropW,
      crop_height: cropH,
      crop_sha256: cropSha,
      ocr_started_at: sr.ocr ? now - sr.ocrMs : null,
      ocr_completed_at: sr.ocr ? now : null,
      ocr_success: sr.ocr !== null,
      ocr_service: sr.ocr ? OCR_SERVICE : null,
      ocr_model_version: 'crnn_jamo_no_null',
      ocr_raw_text: sr.ocr?.text ?? null,
      ocr_normalized_text: sr.ocr ? sr.ocr.text.normalize('NFC').replace(/[ 　]/g, '') : null,
      ocr_confidence: sr.ocr?.confidence ?? null,
      gate_score: sr.gateScore,
      gate_grade: sr.gateGrade,
      gate_decision: sr.gateDecision,
      gate_threshold: session.gate_pass_threshold,
      gate_model_version: GATE_MODEL_VERSION,
      created_at: now,
      updated_at: now,
      content_type: 'dictation',
      template_id: template.template_id,
      word_id: slot.word_id,
      target_word: slot.target_word,
      gate_pass_threshold: session.gate_pass_threshold,
      class_group: session.class_group,
      // 철자는 판정 미사용 — 아래 3필드는 연구 로그용(웹판 v2)
      jamo_edit_distance: sr.jamo?.distance ?? null,
      wrong_jamo_positions: sr.jamo
        ? JSON.stringify(
            sr.jamo.errors.map((e) => ({
              syllable_index: e.syllable_index,
              role: e.role,
              expected: e.expected,
              written: e.written,
              type: e.type,
            }))
          )
        : null,
      spelling_correct: sr.jamo?.correct ?? null,
      reward_level: sr.status === 'pass' ? sr.rewardLevel : 0,
      retry_index: state.captureIndex,
      escape_used:
        sr.gateDecision === 'override' && escapeActive && !passedBefore.has(slot.word_id),
      app_version: APP_VERSION,
      judge_status: sr.status,
      feedback_message: bubbleMessage(sr, w, escapeActive),
      marker_detail: result.markerDetail,
      scan_duration_ms: result.scanMs,
      gate_duration_ms: sr.gateMs,
      ocr_duration_ms: sr.ocrMs,
    };
    await saveAttempt(row);
  }
  await logEvent('sheet_judged', {
    sessionId: session.session_id,
    participantId: session.participant_id,
    payload: {
      captureIndex: state.captureIndex,
      slots: result.slots.map((sr) => ({
        wordId: sr.wordId,
        status: sr.status,
        gateGrade: sr.gateGrade,
        gateDecision: sr.gateDecision,
      })),
    },
  });
}

/* ───────── 모아 보기 / 종료 ───────── */

async function showCollection(): Promise<void> {
  stopAr();
  stopStage();
  const template = state.template!;
  const items = template.note_slots
    .map((s, i) => ({ sceneKey: s.scene_key, rewardLevel: state.words[i].rewardLevel }))
    .filter((it) => it.rewardLevel > 0);
  const wrap = h(`
    <div class="stage-wrap">
      <div class="stage-caption">오늘 만든 낱말 친구들이에요!</div>
      <canvas></canvas>
      <div class="stage-actions"><button class="big-btn green" id="btn-finish">오늘 받아쓰기 끝!</button></div>
    </div>`);
  document.body.appendChild(wrap);
  const canvas = wrap.querySelector('canvas') as HTMLCanvasElement;
  state.stage = playCollection(canvas, items);
  await logEvent('collection_shown', {
    sessionId: state.session!.session_id,
    participantId: state.session!.participant_id,
    payload: { rewardLevels: state.words.map((w) => w.rewardLevel) },
  });
  wrap.querySelector('#btn-finish')!.addEventListener('click', () => void finishSession());
}

async function finishSession(): Promise<void> {
  stopStage();
  stopAr();
  showOverlay('오늘 기록을 정리하고 있어요…');
  const session = state.session!;
  session.ended_at = Date.now();
  session.session_status = 'completed';
  session.updated_at = Date.now();
  await saveSession(session);
  await logEvent('session_completed', {
    sessionId: session.session_id,
    participantId: session.participant_id,
  });
  try {
    await exportSessionPackage(session, state.participant!);
    void processUploadQueue();
  } catch (e) {
    await logEvent('export_failed', {
      sessionId: session.session_id,
      severity: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  hideOverlay();
  const el = h(`
    <div class="screen">
      <h1>참 잘했어요! 🌱</h1>
      <p class="speech">오늘 받아쓰기를 모두 마쳤어요.<br/>다음 시간에 또 만나요!</p>
      <button class="big-btn" id="btn-home">처음으로</button>
    </div>`);
  el.querySelector('#btn-home')!.addEventListener('click', () => {
    state.session = null;
    state.template = null;
    renderSessionSelect();
  });
  setScreen(el);
}

/* ───────── 교사/연구자 설정 (PIN) ───────── */

async function renderSettingsGate(): Promise<void> {
  const pin = await getSetting('teacher_pin', DEFAULT_PIN);
  const entered = window.prompt('교사 설정 PIN을 입력하세요');
  if (entered === null) return;
  if (entered !== pin) {
    window.alert('PIN이 올바르지 않습니다.');
    return;
  }
  await renderSettings();
}

async function renderSettings(): Promise<void> {
  const cfg = await getUploadConfig();
  const uploads = await listUploads();
  const sessionActive = state.session !== null && state.session.session_status === 'active';
  const el = h(`
    <div class="screen">
      <h1>교사/연구자 설정</h1>
      ${sessionActive ? '<div class="feedback warn">차시 진행 중에는 설정을 바꿀 수 없어요 (지시문 §2).</div>' : ''}
      <div class="card">
        <div class="field"><label>학급 유형 (통과 임계)</label>
          <select id="class-group" ${sessionActive ? 'disabled' : ''}>
            <option value="A">A반 — 임계 4</option>
            <option value="B">B반 — 임계 3</option>
          </select>
        </div>
        <div class="field"><label>업로드 함수 URL</label><input id="upload-url" ${sessionActive ? 'disabled' : ''} /></div>
        <div class="field"><label>업로드 토큰</label><input id="upload-token" type="password" ${sessionActive ? 'disabled' : ''} /></div>
        <button class="big-btn" id="btn-save" ${sessionActive ? 'disabled' : ''}>저장</button>
      </div>
      <div class="card">
        <b>업로드 큐</b>
        <table class="settings-table"><thead><tr><th>세션</th><th>상태</th><th>시도</th><th>오류</th></tr></thead>
        <tbody>${uploads
          .map(
            (u) =>
              `<tr><td>${u.session_id.slice(0, 18)}…</td><td>${u.status}</td><td>${u.attempt_count}</td><td>${u.last_error ?? ''}</td></tr>`
          )
          .join('')}</tbody></table>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="big-btn ghost" id="btn-retry" style="width:auto;padding:10px 16px;font-size:1rem">지금 업로드 재시도</button>
          <button class="big-btn ghost" id="btn-download" style="width:auto;padding:10px 16px;font-size:1rem">최근 패키지 내려받기</button>
        </div>
      </div>
      <div class="card">
        <b>도구</b>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <a class="big-btn ghost" href="#print" style="width:auto;padding:10px 16px;font-size:1rem">학습지 인쇄</a>
        </div>
        <p class="muted">앱 버전 ${APP_VERSION} · 게이트 ${GATE_MODEL_VERSION} · OCR crnn(jamo_no_null)</p>
      </div>
      <button class="big-btn ghost" id="btn-close">닫기</button>
    </div>`);
  (el.querySelector('#class-group') as HTMLSelectElement).value = state.classGroup;
  (el.querySelector('#upload-url') as HTMLInputElement).value = cfg.functionUrl;
  (el.querySelector('#upload-token') as HTMLInputElement).value = cfg.token;
  el.querySelector('#btn-save')!.addEventListener('click', async () => {
    const group = (el.querySelector('#class-group') as HTMLSelectElement).value as ClassGroup;
    state.classGroup = group;
    await setSetting('class_group', group);
    await setUploadConfig({
      functionUrl: (el.querySelector('#upload-url') as HTMLInputElement).value.trim(),
      token: (el.querySelector('#upload-token') as HTMLInputElement).value.trim(),
    });
    await logEvent('settings_changed', {
      payload: { classGroup: group, gatePassThreshold: GATE_PASS_THRESHOLD[group] },
    });
    window.alert('저장했습니다.');
  });
  el.querySelector('#btn-retry')!.addEventListener('click', () => void processUploadQueue());
  el.querySelector('#btn-download')!.addEventListener('click', async () => {
    const rows = await listUploads();
    const latest = rows[0];
    if (!latest) {
      window.alert('패키지가 없습니다.');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(latest.blob);
    a.download = latest.package_name;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  el.querySelector('#btn-close')!.addEventListener('click', () => {
    if (state.session && state.session.session_status === 'active') void renderCapture();
    else renderLogin();
  });
  setScreen(el);
}

/* ───────── 개발/검증 훅 (E2E 시연용) ───────── */

function exposeDevHooks(): void {
  (window as unknown as Record<string, unknown>).dictwebDev = {
    state,
    /** URL/Blob 이미지를 촬영 입력으로 주입해 일괄 판정 (판정 분기 시연) */
    async submitImage(src: string | Blob): Promise<void> {
      const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
      const raster = await fileToRaster(blob);
      const statusEl = (document.querySelector('.ar-status') as HTMLElement) ?? h('<span></span>');
      await handleCapture(raster, statusEl, () => {
        const allPassed = state.words.every((w) => w.passed);
        const collectBtn = document.querySelector('#btn-collect') as HTMLButtonElement | null;
        if (collectBtn) collectBtn.style.display = allPassed ? '' : 'none';
      }, true);
    },
    async login(classCode: string, studentNo: string): Promise<void> {
      await doLogin(classCode, studentNo);
      renderSessionSelect();
    },
    async begin(templateIdx: number): Promise<void> {
      await beginSession(state.templates[templateIdx]);
    },
    async openCapture(): Promise<void> {
      await renderCapture();
    },
    async collect(): Promise<void> {
      await showCollection();
    },
    setClassGroup(group: ClassGroup): void {
      state.classGroup = group;
      void setSetting('class_group', group);
    },
    /** 그림 단서 정지컷 dataURL (인쇄 자산 추출용) */
    cue(sceneKey: string): string {
      return cueStill(sceneKey);
    },
    /** 최신 업로드 패키지 구조 검증 (검증 체크리스트 §8-7) */
    async inspectLatestPackage(): Promise<unknown> {
      const { unzipSync } = await import('fflate');
      const rows = await listUploads();
      const latest = rows[0];
      if (!latest) return { error: 'no package' };
      const entries = unzipSync(new Uint8Array(await latest.blob.arrayBuffer()));
      const names = Object.keys(entries);
      const exportJson = JSON.parse(new TextDecoder().decode(entries['export.json']));
      const attempt = exportJson.dictationAttempts?.[0] ?? {};
      return {
        package: latest.package_name,
        entries: names,
        counts: {
          attempts: exportJson.dictationAttempts?.length,
          events: exportJson.eventLogs?.length,
          assets: exportJson.fileAssets?.length,
          images: names.filter((n) => n.startsWith('images/')).length,
        },
        attemptFields: Object.keys(attempt),
      };
    },
  };
}
