/**
 * 촬영 1회(학습지 전체) 판정 파이프라인 — 웹판 v2 흐름(사용자 확정 2026-08-27):
 * 학생이 4낱말을 모두 쓴 뒤 1회 촬영 → ArUco 4점 검출 → 호모그래피 → 4칸 일괄 판정.
 * 통과 = 게이트(명료성)만. 철자(자모 대조)는 판정에서 제외하고 연구 로그용으로만 기록
 * (OCR 오인식이 정답 글씨를 오류로 판정할 위험 때문 — 사용자 결정).
 * 탈출구: 같은 word_id 게이트 REJECT 누적 3회 → 다음 촬영부터 override 통과.
 */
import { analyzeBlank, type BlankMetrics } from './blank';
import type { Engines } from './engines';
import { compare, type CompareResult } from './jamo';
import type { OcrOutput } from './ocr';
import type { Raster } from './raster';
import {
  detectArucoMarkers,
  homographyFromPoints,
  slotRectMm,
  warpRectCrop,
  type DetectedMarker,
  type Homography,
} from './vision';
import type { DictTemplate } from './worksheet';

export type SheetStatus =
  | 'retake_markers' // 마커 미검출/부족 — 재촬영 안내
  | 'wrong_template' // 다른 차시 학습지
  | 'ok';

export type SlotStatus =
  | 'blank' // 아직 쓰지 않음 — 판정 아님
  | 'gate_reject' // 명료성 미달 — 동기 부여 메시지
  | 'pass'; // 통과 — AR 실체화 + 칭찬

export interface SlotJudgeResult {
  slotIndex: number; // 0-based
  wordId: string;
  status: SlotStatus;
  blank: BlankMetrics | null;
  gateGrade: number | null;
  gateScore: number | null;
  gateDecision: 'pass' | 'reject' | 'override' | null;
  /** 통과 시 연출 등급 3/4/5 (override는 3) */
  rewardLevel: number;
  ocr: OcrOutput | null; // 로그용 (판정 미사용)
  jamo: CompareResult | null; // 로그용 (판정 미사용)
  cropOcrWide: Raster | null;
  gateMs: number;
  ocrMs: number;
}

export interface SheetJudgeResult {
  status: SheetStatus;
  markerFound: number;
  markerDetail: string;
  detectedTemplateId: string | null;
  homography: Homography | null;
  slots: SlotJudgeResult[];
  scanMs: number;
}

export interface SheetJudgeOptions {
  template: DictTemplate;
  gatePassThreshold: number; // A=4 / B=3
  /** word_id → 게이트 REJECT 누적 3회 이상 여부(탈출구 활성) */
  escapeActiveByWord: Record<string, boolean>;
  /** 이미 통과한 word_id — 재촬영에서도 통과 상태 유지(게이트·공백은 기록만) */
  passedWords: Set<string>;
  allTemplates: DictTemplate[];
  /** true면 OCR·자모 대조(로그용)까지 수행. 기본 true. */
  runOcrForLogging?: boolean;
}

/** 라이브 AR 추적용: 마커 검출 + 기대 템플릿 매칭만 수행(판정 없음, 빠름) */
export function trackSheet(
  raster: Raster,
  template: DictTemplate,
  allTemplates: DictTemplate[]
): { markerFound: number; homography: Homography | null; wrongTemplateId: string | null } {
  const detected = detectArucoMarkers(raster);
  const byId = new Map<number, DetectedMarker>();
  for (const m of detected) byId.set(m.id, m);
  const wanted = template.corner_markers;
  const found = wanted.filter((w) => byId.has(w.aruco_id));
  if (found.length === 4) {
    return {
      markerFound: 4,
      homography: homographyFromMarkers(wanted, byId),
      wrongTemplateId: null,
    };
  }
  for (const t of allTemplates) {
    if (t.template_id === template.template_id) continue;
    if (t.corner_markers.every((m) => byId.has(m.aruco_id))) {
      return { markerFound: found.length, homography: null, wrongTemplateId: t.template_id };
    }
  }
  return { markerFound: found.length, homography: null, wrongTemplateId: null };
}

function homographyFromMarkers(
  wanted: DictTemplate['corner_markers'],
  byId: Map<number, DetectedMarker>
): Homography {
  return homographyFromPoints(
    wanted.map((w) => ({
      x: w.top_left_mm[0] + w.size_mm[0] / 2,
      y: w.top_left_mm[1] + w.size_mm[1] / 2,
    })),
    wanted.map((w) => {
      const d = byId.get(w.aruco_id)!;
      return { x: d.centerX, y: d.centerY };
    })
  );
}

export async function judgeSheet(
  raster: Raster,
  engines: Engines,
  opt: SheetJudgeOptions
): Promise<SheetJudgeResult> {
  const t0 = performance.now();
  const detected = detectArucoMarkers(raster);
  const byId = new Map<number, DetectedMarker>();
  for (const m of detected) byId.set(m.id, m);
  const wanted = opt.template.corner_markers;
  const found = wanted.filter((w) => byId.has(w.aruco_id));
  const markerDetail =
    `markers=${found.length}/4 ` +
    wanted.map((w) => `${w.anchor}:${byId.has(w.aruco_id) ? 'ok' : 'miss'}`).join(',') +
    ` detectedIds=[${detected.map((m) => m.id).join(',')}]`;

  const result: SheetJudgeResult = {
    status: 'retake_markers',
    markerFound: found.length,
    markerDetail,
    detectedTemplateId: null,
    homography: null,
    slots: [],
    scanMs: 0,
  };

  if (found.length < 4) {
    for (const t of opt.allTemplates) {
      if (t.template_id === opt.template.template_id) continue;
      if (t.corner_markers.every((m) => byId.has(m.aruco_id))) {
        result.status = 'wrong_template';
        result.detectedTemplateId = t.template_id;
        break;
      }
    }
    result.scanMs = Math.round(performance.now() - t0);
    return result;
  }

  result.status = 'ok';
  result.detectedTemplateId = opt.template.template_id;
  const h = homographyFromMarkers(wanted, byId);
  result.homography = h;
  const [pageW, pageH] = opt.template.page.size_mm;
  result.scanMs = Math.round(performance.now() - t0);

  for (let i = 0; i < opt.template.note_slots.length; i++) {
    const slot = opt.template.note_slots[i];
    const [sx, sy, sw, sh] = slot.rect_mm;
    const spec = { xMm: sx, yMm: sy, wMm: sw, hMm: sh };
    const sr: SlotJudgeResult = {
      slotIndex: i,
      wordId: slot.word_id,
      status: 'blank',
      blank: null,
      gateGrade: null,
      gateScore: null,
      gateDecision: null,
      rewardLevel: 0,
      ocr: null,
      jamo: null,
      cropOcrWide: null,
      gateMs: 0,
      ocrMs: 0,
    };
    result.slots.push(sr);

    // 공백 감지 (BlankAnalysis 프로파일 — 파라미터 원본 동일)
    const blankCrop = warpRectCrop(raster, h, slotRectMm(spec, pageW, pageH, 'blank_analysis'), pageW);
    if (!blankCrop) continue;
    sr.blank = analyzeBlank(blankCrop);
    const ocrCrop = warpRectCrop(raster, h, slotRectMm(spec, pageW, pageH, 'ocr_wide'), pageW);
    sr.cropOcrWide = ocrCrop;
    if (sr.blank.localBlank || !ocrCrop) continue; // status='blank'

    // 게이트 v1 — 통과·거부 무관 전 칸 기록(지시문 §6)
    const tGate = performance.now();
    const gate = await engines.gate.classify(ocrCrop);
    sr.gateMs = Math.round(performance.now() - tGate);
    sr.gateGrade = gate.grade;
    sr.gateScore = gate.score;

    const alreadyPassed = opt.passedWords.has(slot.word_id);
    const gatePassed = gate.grade >= opt.gatePassThreshold;
    const escapeActive = opt.escapeActiveByWord[slot.word_id] === true;
    if (gatePassed) sr.gateDecision = 'pass';
    else if (alreadyPassed || escapeActive) sr.gateDecision = 'override';
    else sr.gateDecision = 'reject';

    sr.status = sr.gateDecision === 'reject' ? 'gate_reject' : 'pass';
    if (sr.status === 'pass') {
      sr.rewardLevel = Math.min(5, Math.max(3, gate.grade));
    }

    // OCR + 자모 대조 — 연구 로그용(판정 미사용). 통과 칸만 수행(미달 크롭 OCR 신뢰 불가).
    if (sr.status === 'pass' && opt.runOcrForLogging !== false) {
      const tOcr = performance.now();
      const ocr = await engines.ocr.recognize(ocrCrop);
      sr.ocrMs = Math.round(performance.now() - tOcr);
      sr.ocr = ocr;
      sr.jamo = compare(ocr.text, slot.target_word);
    }
  }
  return result;
}
