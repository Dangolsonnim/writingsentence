/**
 * 판정 분기 E2E — 웹판 v2 흐름(전체 학습지 1회 촬영 → 4칸 일괄 판정) +
 * 철자 검증 모드(지시문 §3: 통과 = 게이트 AND 강제 정렬 여유도 M ≤ τ1).
 * 순수 Node 러너 (vitest 워커에서 opencv.js WASM이 크래시하여 별도 실행):
 *   npm run test:e2e
 *
 * 게이트 v1은 실제 연필 손글씨 캡처 도메인에 특화되어 합성 폰트 글씨를 저등급(0)으로
 * 거부한다(실물 크롭은 같은 파이프라인에서 4~5등급). 게이트 통과 경로는 실물 손글씨 크롭
 * 합성(p_real — 내용이 정답 낱말과 달라 검증 오답 경로도 겸함)으로, 탈출구·통과·철자
 * 분기는 폰트 시트(OCR이 정확히 읽는 실측 설정)로 시연한다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-node';
import { GateEngine } from '../src/core/gate';
import { CrnnTokenizer } from '../src/core/hangul';
import { OcrEngine } from '../src/core/ocr';
import { judgeSheet, type SheetJudgeOptions } from '../src/core/pipeline';
import { resizeBilinear, type Raster } from '../src/core/raster';
import { SpellVerifier } from '../src/core/verify';
import { initCv } from '../src/core/vision';
import type { Engines } from '../src/core/engines';
import type { DictTemplate } from '../src/core/worksheet';

// esbuild 번들 실행 위치와 무관하게 프로젝트 루트에서 실행한다는 전제(process.cwd()).
const root = process.cwd();
const syn = join(root, 'tests', 'fixtures', 'synthetic');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${name} ${detail}`);
}

function loadPng(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  const raster: Raster = {
    data: new Uint8ClampedArray(png.data),
    width: png.width,
    height: png.height,
  };
  const maxSide = 2400; // 앱과 동일 상한
  const scale = Math.min(1, maxSide / Math.max(raster.width, raster.height));
  if (scale >= 1) return raster;
  return resizeBilinear(raster, Math.round(raster.width * scale), Math.round(raster.height * scale));
}

function loadTemplate(id: string): DictTemplate {
  return JSON.parse(readFileSync(join(root, 'public', 'worksheets', `${id}.json`), 'utf-8'));
}

async function main(): Promise<void> {
  await initCv();
  const gateSession = await ort.InferenceSession.create(join(root, 'public', 'models', 'gate_v1.onnx'));
  const ocrSession = await ort.InferenceSession.create(join(root, 'public', 'models', 'crnn.onnx'));
  const tokenizer = CrnnTokenizer.fromJson(
    readFileSync(join(root, 'public', 'models', 'tokenizer.json'), 'utf-8')
  );
  const gateInput = gateSession.inputNames[0];
  const ocrRunner = {
    async run(images: Float32Array, dims: number[], imageWidths: BigInt64Array) {
      const out = await ocrSession.run({
        images: new ort.Tensor('float32', images, dims),
        image_widths: new ort.Tensor('int64', imageWidths, [1]),
      });
      const first = out[ocrSession.outputNames[0]];
      return { data: first.data as Float32Array, dims: first.dims };
    },
  };
  const engines: Engines = {
    gate: new GateEngine({
      async run(input, dims) {
        const out = await gateSession.run({ [gateInput]: new ort.Tensor('float32', input, dims) });
        const first = out[gateSession.outputNames[0]];
        return { data: first.data as Float32Array, dims: first.dims };
      },
    }),
    ocr: new OcrEngine(ocrRunner, tokenizer),
    verifier: new SpellVerifier(ocrRunner, tokenizer),
    tokenizer,
  };
  const templates = ['DICT_01_v1', 'DICT_02_v1', 'DICT_03_v1'].map(loadTemplate);
  const opts = (overrides: Partial<SheetJudgeOptions> = {}): SheetJudgeOptions => ({
    template: templates[0],
    gatePassThreshold: 3,
    escapeActiveByWord: {},
    passedWords: new Set<string>(),
    allTemplates: templates,
    ...overrides,
  });

  console.log('게이트 통과(실물 손글씨, 1번 칸) — 통과 + OCR 로그 산출:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_real.png')), engines, opts());
    const s0 = r.slots[0];
    console.log(
      `  sheet=${r.status} slot0=${s0.status} grade=${s0.gateGrade} M=${s0.verify?.margin.toFixed(3)} free='${s0.verify?.freeText}' est='${s0.verify?.estimatedWritten}' msg='${s0.verify?.jamo?.message}' scan=${r.scanMs}ms`
    );
    check('마커 4점 검출', r.status === 'ok' && r.markerFound === 4, r.markerDetail);
    check('slot0 게이트 통과(등급≥3)', (s0.gateGrade ?? 0) >= 3 && s0.gateDecision === 'pass');
    check('검증: 다른 낱말 → M > τ2 → spell_wrong', s0.status === 'spell_wrong' && (s0.verify?.margin ?? 0) > 0.45);
    check('오답 위치 특정: 추정 낱말 + 대조기 문구', !!s0.verify?.estimatedWritten && !!s0.verify?.jamo?.message);
    check('나머지 칸 blank', r.slots.slice(1).every((s) => s.status === 'blank'));
  }

  console.log('품질 미달(폰트/낙서) → gate_reject, OCR 생략(품질 우선):');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_namu.png')), engines, opts());
    const s0 = r.slots[0];
    console.log(`  slot0=${s0.status} grade=${s0.gateGrade}`);
    check('폰트: gate_reject + 검증 생략(품질 우선)', s0.status === 'gate_reject' && s0.verify === null);
    const r2 = await judgeSheet(loadPng(join(syn, 'p_scribble.png')), engines, opts());
    const t0 = r2.slots[0];
    console.log(`  낙서 slot0=${t0.status} grade=${t0.gateGrade} score=${t0.gateScore?.toFixed(3)}`);
    check('낙서: gate_reject', t0.status === 'gate_reject' && t0.gateDecision === 'reject');
  }

  console.log('탈출구: REJECT 3회 누적 후 override 통과(연출 3):');
  {
    const r = await judgeSheet(
      loadPng(join(syn, 'p_namu.png')),
      engines,
      opts({ escapeActiveByWord: { D1W1: true } })
    );
    const s0 = r.slots[0];
    console.log(`  slot0=${s0.status} decision=${s0.gateDecision} reward=${s0.rewardLevel} M=${s0.verify?.margin.toFixed(3)} free='${s0.verify?.freeText}'`);
    check('override + 검증 정답(M ≤ τ1) → pass', s0.status === 'pass' && s0.gateDecision === 'override' && s0.verify?.decision === 'correct');
    check('override 연출 등급 3', s0.rewardLevel === 3);
  }

  console.log('1-자모 오답: 나모(폰트) vs 정답 나무 — 기본 임계 + 임계 분기 강제:');
  {
    // 기본 τ(0.25/0.45): 도메인평가_결과.md §4의 예고대로 또박또박 쓴 1-자모 오답은
    // M이 중간(실측 0.21 부근)에 와 τ1 아래로 들어올 수 있다 — 판정은 임계 일관성만 확인,
    // M 연속값 로깅이 파일럿 재보정 재료(전 칸 기록).
    const rDef = await judgeSheet(
      loadPng(join(syn, 'p_namo.png')),
      engines,
      opts({ escapeActiveByWord: { D1W1: true } })
    );
    const d0 = rDef.slots[0];
    const m = d0.verify?.margin ?? NaN;
    console.log(`  [기본 τ] slot0=${d0.status} M=${m.toFixed(3)} free='${d0.verify?.freeText}'`);
    check('M 기록 + 자유 복호 = 나모', Number.isFinite(m) && d0.verify?.freeText === '나모');
    const expected = m <= 0.25 ? 'pass' : m <= 0.45 ? 'spell_unclear' : 'spell_wrong';
    check(`판정-임계 일관(${expected})`, d0.status === expected);

    // 유보 분기 강제: τ1 < M ≤ τ2
    const rUn = await judgeSheet(
      loadPng(join(syn, 'p_namo.png')),
      engines,
      opts({ escapeActiveByWord: { D1W1: true }, verifyTau1: 0.05, verifyTau2: 0.3 })
    );
    console.log(`  [τ=0.05/0.3] slot0=${rUn.slots[0].status}`);
    check('판정 유보(spell_unclear) 분기', rUn.slots[0].status === 'spell_unclear');

    // 오답 확정 분기 강제: M > τ2 → 1-자모 이웃 탐색 → 위치 특정
    const rWr = await judgeSheet(
      loadPng(join(syn, 'p_namo.png')),
      engines,
      opts({ escapeActiveByWord: { D1W1: true }, verifyTau1: 0.05, verifyTau2: 0.15 })
    );
    const w0 = rWr.slots[0];
    console.log(
      `  [τ=0.05/0.15] slot0=${w0.status} est='${w0.verify?.estimatedWritten ?? ''}' msg='${w0.verify?.jamo?.message ?? ''}'`
    );
    check('오답 확정(spell_wrong) 분기', w0.status === 'spell_wrong');
    check('추정 낱말 = 나모 (1-자모 이웃 탐색)', w0.verify?.estimatedWritten === '나모');
    check('중성 지적 문구', (w0.verify?.jamo?.message ?? '').includes('중성'));
  }

  console.log('통과 상태 유지: 이미 통과한 낱말은 미달 크롭이어도 pass 유지:');
  {
    const r = await judgeSheet(
      loadPng(join(syn, 'p_scribble.png')),
      engines,
      opts({ passedWords: new Set(['D1W1']) })
    );
    const s0 = r.slots[0];
    console.log(`  slot0=${s0.status} decision=${s0.gateDecision}`);
    check('passed 유지(override)', s0.status === 'pass' && s0.gateDecision === 'override');
  }

  console.log('공백 시트: 4칸 전부 blank:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_blank.png')), engines, opts());
    console.log(`  slots=${r.slots.map((s) => s.status).join(',')}`);
    check('전 칸 blank + 검증 없음', r.slots.every((s) => s.status === 'blank' && s.verify === null));
    check('전 칸 게이트 무기록(공백)', r.slots.every((s) => s.gateGrade === null));
  }

  console.log('전체 시트(4칸 기입) + 탈출구 전체 → 4칸 모두 통과:');
  {
    const escape = Object.fromEntries(templates[0].note_slots.map((s) => [s.word_id, true]));
    const r = await judgeSheet(
      loadPng(join(syn, 'p_full_t1.png')),
      engines,
      opts({ escapeActiveByWord: escape })
    );
    console.log(
      '  ' + r.slots.map((s) => `${s.wordId}:${s.status}(g${s.gateGrade},M=${s.verify?.margin.toFixed(3)})`).join(' ')
    );
    check('4칸 모두 pass(검증 정답)', r.slots.every((s) => s.status === 'pass' && s.verify?.decision === 'correct'));
    check('전 칸 gate_grade·M 기록', r.slots.every((s) => s.gateGrade !== null && s.verify !== null));
  }

  console.log('다른 차시 학습지 → wrong_template:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_sagwa_t2.png')), engines, opts());
    console.log(`  sheet=${r.status} detected=${r.detectedTemplateId}`);
    check('wrong_template', r.status === 'wrong_template' && r.detectedTemplateId === 'DICT_02_v1');
  }

  console.log('임계 차등 A(4)/B(3):');
  {
    const rB = await judgeSheet(loadPng(join(syn, 'p_real.png')), engines, opts({ gatePassThreshold: 3 }));
    const rA = await judgeSheet(loadPng(join(syn, 'p_real.png')), engines, opts({ gatePassThreshold: 4 }));
    const a0 = rA.slots[0];
    const b0 = rB.slots[0];
    console.log(`  A: decision=${a0.gateDecision} grade=${a0.gateGrade} / B: decision=${b0.gateDecision}`);
    check('B(3) pass', b0.gateDecision === 'pass');
    check(
      'A(4) 등급-임계 일관',
      (a0.gateGrade ?? 0) >= 4 ? a0.gateDecision === 'pass' : a0.status === 'gate_reject'
    );
  }

  console.log(failures === 0 ? '\nE2E 전체 PASS' : `\nE2E 실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
