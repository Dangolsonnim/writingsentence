/**
 * 판정 분기 E2E — 웹판 v2 흐름 + margin 판정 모드(기본, 2026-08-28 사용자 확정:
 * 게이트를 판정에서 제외하고 AI 읽기 신뢰도(conf)·강제 정렬 여유도(M)로 판정).
 *   통과 = conf ≥ λ AND M ≤ τ1 (인쇄체처럼 잘 읽히는 글씨)
 *   conf < λ → illegible (낙서/판독 불가 — 글씨체 안내)
 *   읽히지만 M > τ2 → 1-자모 이웃 특정(철자 문구) 또는 '처음부터' 강등 문구
 * gate 모드(기존 게이트 등급 임계)는 연구 비교용으로 유지·별도 검증.
 * 순수 Node 러너 (vitest 워커에서 opencv.js WASM이 크래시하여 별도 실행):
 *   npm run test:e2e
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
    allTemplates: templates,
    ...overrides,
  });

  console.log('[margin] 인쇄체풍 정자(폰트 나무) → 게이트 무관 직접 통과:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_namu.png')), engines, opts());
    const s0 = r.slots[0];
    console.log(
      `  slot0=${s0.status} gate(참고)=${s0.gateGrade} conf=${s0.verify?.freeConf.toFixed(2)} M=${s0.verify?.margin.toFixed(3)} reward=${s0.rewardLevel}`
    );
    check('마커 4점 검출', r.status === 'ok' && r.markerFound === 4, r.markerDetail);
    check('통과(게이트 0등급이어도)', s0.status === 'pass' && (s0.gateGrade ?? 9) <= 1);
    check('연출 등급 5(M≈0)', s0.rewardLevel === 5);
    check('게이트는 로깅됨(참고값)', s0.gateGrade !== null && s0.gateScore !== null);
    check('나머지 칸 blank', r.slots.slice(1).every((sl) => sl.status === 'blank'));
  }

  console.log('[margin] 낙서 → illegible(읽기 신뢰도 차단) + 글씨체 안내:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_scribble.png')), engines, opts());
    const s0 = r.slots[0];
    console.log(
      `  slot0=${s0.status} conf=${s0.verify?.freeConf.toFixed(2)} M=${s0.verify?.margin.toFixed(3)} msg='${s0.verify?.message}'`
    );
    check('illegible', s0.status === 'illegible' && (s0.verify?.freeConf ?? 1) < 0.35);
    check('글씨체 안내 문구', (s0.verify?.message ?? '').includes('반듯'));
  }

  console.log('[margin] 부분 판독(날려쓴 글씨 시뮬: 나 vs 나무) → 완전성 차단 illegible:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_partial.png')), engines, opts());
    const s0 = r.slots[0];
    console.log(
      `  slot0=${s0.status} conf=${s0.verify?.freeConf.toFixed(2)} C=${s0.verify?.completeness.toFixed(2)} M=${s0.verify?.margin.toFixed(3)} free='${s0.verify?.freeText}'`
    );
    check('완전성 C < 0.75 → illegible', s0.status === 'illegible' && (s0.verify?.completeness ?? 1) < 0.75);
    check('글씨체 안내 문구', (s0.verify?.message ?? '').includes('반듯'));
  }

  console.log('[margin] 판독 가능한 큰 오류(실물 로봇 명령 vs 나무) → 처음부터 문구:');
  {
    // 기본 λ=0.8에서는 이 크롭(conf 0.39)이 illegible로 먼저 걸리므로 λ를 낮춰 해당 분기 검증
    const r = await judgeSheet(loadPng(join(syn, 'p_real.png')), engines, opts({ verifyLambda: 0.3 }));
    const s0 = r.slots[0];
    console.log(
      `  slot0=${s0.status} conf=${s0.verify?.freeConf.toFixed(2)} M=${s0.verify?.margin.toFixed(3)} M_best=${s0.verify?.bestNeighborMargin?.toFixed(3)} msg='${s0.verify?.message}'`
    );
    check('spell_wrong(큰 오류)', s0.status === 'spell_wrong');
    check('처음부터 강등 문구', (s0.verify?.message ?? '').includes('처음부터'));
  }

  console.log('[margin] 탈출구: illegible 누적 3회 → override 통과(연출 3):');
  {
    const r = await judgeSheet(
      loadPng(join(syn, 'p_scribble.png')),
      engines,
      opts({ escapeActiveByWord: { D1W1: true } })
    );
    const s0 = r.slots[0];
    console.log(`  slot0=${s0.status} decision=${s0.gateDecision} reward=${s0.rewardLevel}`);
    check('override → pass', s0.status === 'pass' && s0.gateDecision === 'override');
    check('override 연출 등급 3', s0.rewardLevel === 3);
  }

  console.log('[margin] 1-자모 오답: 나모(폰트) vs 정답 나무 — 기본 임계 + 임계 분기 강제:');
  {
    // 기본 τ(0.25/0.45): 도메인평가_결과.md §4의 예고대로 또박또박 쓴 1-자모 오답은
    // M이 중간(실측 0.21 부근)에 와 τ1 아래로 들어올 수 있다 — 판정은 임계 일관성만 확인,
    // M 연속값 로깅이 파일럿 재보정 재료(전 칸 기록).
    const rDef = await judgeSheet(loadPng(join(syn, 'p_namo.png')), engines, opts());
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
      opts({ verifyTau1: 0.05, verifyTau2: 0.3 })
    );
    console.log(`  [τ=0.05/0.3] slot0=${rUn.slots[0].status}`);
    check('판정 유보(spell_unclear) 분기', rUn.slots[0].status === 'spell_unclear');

    // 오답 확정 분기 강제: M > τ2 → 1-자모 이웃 탐색 → 위치 특정
    const rWr = await judgeSheet(
      loadPng(join(syn, 'p_namo.png')),
      engines,
      opts({ verifyTau1: 0.05, verifyTau2: 0.15 })
    );
    const w0 = rWr.slots[0];
    console.log(
      `  [τ=0.05/0.15] slot0=${w0.status} est='${w0.verify?.estimatedWritten ?? ''}' msg='${w0.verify?.jamo?.message ?? ''}'`
    );
    check('오답 확정(spell_wrong) 분기', w0.status === 'spell_wrong');
    check('추정 낱말 = 나모 (1-자모 이웃 탐색)', w0.verify?.estimatedWritten === '나모');
    check('중성 지적 문구', (w0.verify?.jamo?.message ?? '').includes('중성'));
  }

  console.log('[margin] 매 촬영 재판정: 통과 후 날려 쓰면 다시 미달로 안내(유지 정책 폐지):');
  {
    const good = await judgeSheet(loadPng(join(syn, 'p_full_t1.png')), engines, opts());
    const bad = await judgeSheet(loadPng(join(syn, 'p_scribble.png')), engines, opts());
    console.log(`  1차(정자)=${good.slots[0].status} → 2차(낙서)=${bad.slots[0].status}`);
    check('정자 촬영 pass', good.slots[0].status === 'pass');
    check('직후 낙서 촬영은 pass 아님(재판정)', bad.slots[0].status !== 'pass');
  }

  console.log('공백 시트: 4칸 전부 blank:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_blank.png')), engines, opts());
    console.log(`  slots=${r.slots.map((s) => s.status).join(',')}`);
    check('전 칸 blank + 검증 없음', r.slots.every((s) => s.status === 'blank' && s.verify === null));
    check('전 칸 게이트 무기록(공백)', r.slots.every((s) => s.gateGrade === null));
  }

  console.log('[margin] 전체 시트(4칸 기입) → 탈출구 없이 4칸 모두 직접 통과:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_full_t1.png')), engines, opts());
    console.log(
      '  ' + r.slots.map((s) => `${s.wordId}:${s.status}(g${s.gateGrade},conf=${s.verify?.freeConf.toFixed(2)},M=${s.verify?.margin.toFixed(3)},lv${s.rewardLevel})`).join(' ')
    );
    check('4칸 모두 pass(검증 정답, 탈출구 불필요)', r.slots.every((s) => s.status === 'pass' && s.verify?.decision === 'correct' && s.gateDecision !== 'override'));
    check('전 칸 gate_grade·M·conf 기록', r.slots.every((s) => s.gateGrade !== null && s.verify !== null));
  }

  console.log('다른 차시 학습지 → wrong_template:');
  {
    const r = await judgeSheet(loadPng(join(syn, 'p_sagwa_t2.png')), engines, opts());
    console.log(`  sheet=${r.status} detected=${r.detectedTemplateId}`);
    check('wrong_template', r.status === 'wrong_template' && r.detectedTemplateId === 'DICT_02_v1');
  }

  console.log('[gate 모드] 기존 게이트 판정 경로 회귀 확인:');
  {
    // 게이트 등급 임계 방식이 설정으로 복원 가능해야 함(연구 비교용)
    const rejected = await judgeSheet(
      loadPng(join(syn, 'p_namu.png')),
      engines,
      opts({ judgeMode: 'gate' })
    );
    const g0 = rejected.slots[0];
    console.log(`  폰트 나무(gate): ${g0.status} grade=${g0.gateGrade}`);
    check('gate 모드: 저등급 → gate_reject + 검증 생략', g0.status === 'gate_reject' && g0.verify === null);

    const rB = await judgeSheet(loadPng(join(syn, 'p_real.png')), engines, opts({ judgeMode: 'gate', gatePassThreshold: 3 }));
    const rA = await judgeSheet(loadPng(join(syn, 'p_real.png')), engines, opts({ judgeMode: 'gate', gatePassThreshold: 4 }));
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
