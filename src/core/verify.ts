/**
 * 철자 판정 — 검증(verification) 모드 (지시문 §3, 2026-08-27 도메인 평가로 확정).
 * 자유 복호 문자열 비교가 아니라 CTC 강제 정렬 여유도 M으로 판정한다:
 *   lp = log_softmax(crnn(crop))                        # [T, C]
 *   M  = ( Σ_t max(lp_t) − CTC_forced(lp, 정답 자모열) ) / T
 *   M ≤ τ1(기본 0.25)      → 정답
 *   τ1 < M ≤ τ2(기본 0.45) → 판정 유보(재촬영 안내, 탈출구 카운트 미차감)
 *   M > τ2                 → 오답 확정 → 1-자모 이웃 탐색으로 위치 특정 → 대조기 문구
 *
 * 동등성 골든: 도메인평가/검증여유도_골든36.csv — 같은 크롭에서 M 재현 ±0.01.
 * 전처리는 eval_domain.py와 동일(그레이 → H=32 INTER_AREA 등비 → 폭 4배수 흰색(1.0) 패딩
 * → (x−0.5)/0.5). 참고: OnnxOcrEngine 파리티 경로(양선형·검정 패딩)와 별개의
 * 검증 전용 전처리다 — τ 보정이 이 전처리 기준으로 이루어졌기 때문.
 */
import { compare, type CompareResult } from './jamo';
import { CrnnTokenizer, HangulComposer } from './hangul';
import { lumaAt, type Raster } from './raster';

export const VERIFY_TAU1_DEFAULT = 0.25;
export const VERIFY_TAU2_DEFAULT = 0.45;
/** 읽기 신뢰도(방출 토큰 geomean) 절대 임계 — 실측: 낙서 ≤0.26, 정상 글씨 ≥0.48 */
export const VERIFY_LAMBDA_DEFAULT = 0.35;

export type VerifyDecision = 'correct' | 'unclear' | 'wrong' | 'illegible';

export interface VerifyResult {
  margin: number;
  decision: VerifyDecision;
  tau1: number;
  tau2: number;
  lambda: number;
  frames: number;
  /** 자유 복호 텍스트(로그용) */
  freeText: string;
  /** 자유 복호 방출 토큰 신뢰도 geomean — 절대적 읽기 신뢰도(낙서 차단) */
  freeConf: number;
  /** 오답 확정 시: 최고 점수 1-자모 이웃(학생이 쓴 것으로 추정)과 대조기 결과 */
  estimatedWritten: string | null;
  /** 최고 이웃의 여유도 (free−bestNeighborForced)/T — 판독 가능 오답 vs 판독 불가 구분 */
  bestNeighborMargin: number | null;
  jamo: CompareResult | null;
  message: string | null;
}

const CHO = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const JUNG = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
const JONG = [...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ']; // 27 (없음 제외)

export interface JamoToken {
  name: string; // vocab 토큰명 (CHO_ㄱ 등)
  role: 'CHO' | 'JUNG' | 'JONG';
  jamo: string;
}

/** 완성형 낱말 → 역할 태그 자모 토큰열 (모델 vocab 형식) */
export function wordToTokens(word: string): JamoToken[] {
  const out: JamoToken[] = [];
  for (const ch of word.normalize('NFC')) {
    const o = ch.codePointAt(0)!;
    if (o < 0xac00 || o > 0xd7a3) throw new Error(`한글 완성형 아님: ${ch}`);
    const s = o - 0xac00;
    const cho = Math.floor(s / 588);
    const jung = Math.floor((s % 588) / 28);
    const jong = s % 28;
    out.push({ name: `CHO_${CHO[cho]}`, role: 'CHO', jamo: CHO[cho] });
    out.push({ name: `JUNG_${JUNG[jung]}`, role: 'JUNG', jamo: JUNG[jung] });
    if (jong) out.push({ name: `JONG_${JONG[jong - 1]}`, role: 'JONG', jamo: JONG[jong - 1] });
  }
  return out;
}

/** 검증 전용 전처리 — eval_domain.py ocr() 동일 (그레이 area 리사이즈 + 흰색 패딩) */
export function preprocessForVerify(src: Raster): { data: Float32Array; width: number; padded: number } {
  const h = 32;
  const srcW = src.width;
  const srcH = src.height;
  // 그레이(0..1)
  const gray = new Float64Array(srcW * srcH);
  for (let i = 0; i < srcW * srcH; i++) gray[i] = lumaAt(src.data, i * 4) / 255;
  const nw = Math.max(8, Math.round((srcW * 32.0) / srcH));
  // INTER_AREA(축소): 픽셀 영역 가중 평균 — cv2.resize INTER_AREA 동등
  const out = new Float64Array(nw * h);
  const sx = srcW / nw;
  const sy = srcH / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = Math.min(srcH, (y + 1) * sy);
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx;
      const x1 = Math.min(srcW, (x + 1) * sx);
      let acc = 0;
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          acc += gray[yy * srcW + xx] * wx * wy;
          wsum += wx * wy;
        }
      }
      out[y * nw + x] = wsum > 0 ? acc / wsum : 1.0;
    }
  }
  const padded = nw + ((-nw % 4) + 4) % 4;
  const data = new Float32Array(padded * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < padded; x++) {
      const v = x < nw ? out[y * nw + x] : 1.0; // 흰색 패딩
      data[y * padded + x] = (v - 0.5) / 0.5;
    }
  }
  return { data, width: nw, padded };
}

/** 프레임별 log_softmax (in-place 결과 새 배열) */
export function logSoftmax(logits: Float32Array, frames: number, classes: number): Float64Array {
  const lp = new Float64Array(frames * classes);
  for (let t = 0; t < frames; t++) {
    const off = t * classes;
    let mx = -Infinity;
    for (let k = 0; k < classes; k++) if (logits[off + k] > mx) mx = logits[off + k];
    let sum = 0;
    for (let k = 0; k < classes; k++) sum += Math.exp(logits[off + k] - mx);
    const lse = mx + Math.log(sum);
    for (let k = 0; k < classes; k++) lp[off + k] = logits[off + k] - lse;
  }
  return lp;
}

/** 자유 복호(최적 단일 경로) 점수 = Σ_t max(lp_t) */
export function freeBestScore(lp: Float64Array, frames: number, classes: number): number {
  let s = 0;
  for (let t = 0; t < frames; t++) {
    const off = t * classes;
    let mx = -Infinity;
    for (let k = 0; k < classes; k++) if (lp[off + k] > mx) mx = lp[off + k];
    s += mx;
  }
  return s;
}

/**
 * CTC 강제 정렬(최적 경로, blank 삽입 표준 상태열) — 라벨열의 최고 단일 정렬 log 확률.
 * 상태열: [b, l1, b, l2, …, lL, b] (2L+1). 전이: 유지 / 직전 / (라벨≠직전라벨) 2칸 건너뜀.
 */
export function ctcForced(
  lp: Float64Array,
  frames: number,
  classes: number,
  labels: number[],
  blank: number
): number {
  const L = labels.length;
  const S = 2 * L + 1;
  const stateLabel = (s: number): number => (s % 2 === 0 ? blank : labels[(s - 1) / 2]);
  const NEG = -Infinity;
  let prev = new Float64Array(S).fill(NEG);
  prev[0] = lp[blank];
  if (S > 1) prev[1] = lp[stateLabel(1)];
  const cur = new Float64Array(S);
  for (let t = 1; t < frames; t++) {
    const off = t * classes;
    for (let s = 0; s < S; s++) {
      let best = prev[s];
      if (s >= 1 && prev[s - 1] > best) best = prev[s - 1];
      if (s >= 2 && s % 2 === 1) {
        // 라벨 상태로의 2칸 건너뜀: 같은 라벨 연속이면 금지
        const lbl = stateLabel(s);
        const prevLbl = stateLabel(s - 2);
        if (lbl !== prevLbl && prev[s - 2] > best) best = prev[s - 2];
      }
      cur[s] = best === NEG ? NEG : best + lp[off + stateLabel(s)];
    }
    prev.set(cur);
  }
  return Math.max(prev[S - 1], S >= 2 ? prev[S - 2] : NEG);
}

export interface LogitsProvider {
  /** 검증 전처리 텐서로 crnn 실행 → logits [1,T,C] */
  run(data: Float32Array, dims: number[], imageWidths: BigInt64Array): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

export interface VerifyOptions {
  tau1?: number;
  tau2?: number;
  /** 읽기 신뢰도 절대 임계 (기본 0.35) */
  lambda?: number;
  /** 오답 시 1-자모 이웃 탐색으로 위치 특정 (기본 true) */
  locateError?: boolean;
}

/** 낱말 토큰열 → vocab id 열 (미등록 토큰 없음 전제 — 있으면 예외) */
function tokenIds(tokens: JamoToken[], tokenizer: CrnnTokenizer): number[] {
  return tokens.map((t) => {
    const id = tokenizer.vocab.indexOf(t.name);
    if (id < 0) throw new Error(`vocab에 없는 토큰: ${t.name}`);
    return id;
  });
}

/** 1-자모 이웃 변형 생성: 같은 역할 치환 · 삭제 · 종성 삽입(받침 없는 음절 뒤) */
export function neighborVariants(tokens: JamoToken[]): JamoToken[][] {
  const out: JamoToken[][] = [];
  const roleSet: Record<JamoToken['role'], string[]> = { CHO: CHO, JUNG: JUNG, JONG: JONG };
  for (let i = 0; i < tokens.length; i++) {
    // 치환 (같은 역할)
    for (const j of roleSet[tokens[i].role]) {
      if (j === tokens[i].jamo) continue;
      const v = tokens.slice();
      v[i] = { name: `${tokens[i].role}_${j}`, role: tokens[i].role, jamo: j };
      out.push(v);
    }
    // 삭제
    out.push([...tokens.slice(0, i), ...tokens.slice(i + 1)]);
  }
  // 종성 삽입: JUNG 다음이 JONG이 아닌 위치
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].role !== 'JUNG') continue;
    if (i + 1 < tokens.length && tokens[i + 1].role === 'JONG') continue;
    for (const j of JONG) {
      const v = tokens.slice();
      v.splice(i + 1, 0, { name: `JONG_${j}`, role: 'JONG', jamo: j });
      out.push(v);
    }
  }
  return out;
}

function composeTokens(tokens: JamoToken[], composer: HangulComposer): string {
  return composer.compose(tokens.map((t) => t.name));
}

function greedyText(
  lp: Float64Array,
  frames: number,
  classes: number,
  tokenizer: CrnnTokenizer,
  composer: HangulComposer
): string {
  const toks: string[] = [];
  let prevBest = -1;
  for (let t = 0; t < frames; t++) {
    const off = t * classes;
    let best = 0;
    let bestv = lp[off];
    for (let k = 1; k < classes; k++) {
      if (lp[off + k] > bestv) {
        bestv = lp[off + k];
        best = k;
      }
    }
    if (best !== tokenizer.blankIndex && best !== prevBest) toks.push(tokenizer.tokenAt(best));
    prevBest = best;
  }
  return composer.compose(toks);
}

export class SpellVerifier {
  private composer: HangulComposer;

  constructor(
    private runner: LogitsProvider,
    private tokenizer: CrnnTokenizer
  ) {
    this.composer = new HangulComposer(tokenizer.vocab);
  }

  /** 크롭 1장 → logits 1회 추론 → conf·M 판정(+오답 위치 특정) */
  async verify(crop: Raster, targetWord: string, opt: VerifyOptions = {}): Promise<VerifyResult> {
    const tau1 = opt.tau1 ?? VERIFY_TAU1_DEFAULT;
    const tau2 = opt.tau2 ?? VERIFY_TAU2_DEFAULT;
    const lambda = opt.lambda ?? VERIFY_LAMBDA_DEFAULT;
    const pre = preprocessForVerify(crop);
    const res = await this.runner.run(
      pre.data,
      [1, 1, 32, pre.padded],
      BigInt64Array.from([BigInt(pre.padded)])
    );
    const frames = res.dims[1];
    const classes = res.dims[2];
    const lp = logSoftmax(res.data, frames, classes);
    return this.judgeFromLogProbs(lp, frames, classes, targetWord, tau1, tau2, lambda, opt.locateError !== false);
  }

  /** (골든 러너용) log-prob에서 M만 계산 */
  marginFor(lp: Float64Array, frames: number, classes: number, word: string): number {
    const ids = tokenIds(wordToTokens(word), this.tokenizer);
    const free = freeBestScore(lp, frames, classes);
    const forced = ctcForced(lp, frames, classes, ids, this.tokenizer.blankIndex);
    return (free - forced) / frames;
  }

  /** 자유 복호 방출 토큰 신뢰도 geomean (절대적 읽기 신뢰도) */
  private freeConfidence(lp: Float64Array, frames: number, classes: number): number {
    let sumLog = 0;
    let n = 0;
    let prev = -1;
    for (let t = 0; t < frames; t++) {
      const off = t * classes;
      let best = 0;
      let bestv = lp[off];
      for (let k = 1; k < classes; k++) {
        if (lp[off + k] > bestv) {
          bestv = lp[off + k];
          best = k;
        }
      }
      if (best !== this.tokenizer.blankIndex && best !== prev) {
        sumLog += Math.max(bestv, Math.log(1e-8));
        n++;
      }
      prev = best;
    }
    return n === 0 ? 0 : Math.exp(sumLog / n);
  }

  private judgeFromLogProbs(
    lp: Float64Array,
    frames: number,
    classes: number,
    targetWord: string,
    tau1: number,
    tau2: number,
    lambda: number,
    locateError: boolean
  ): VerifyResult {
    const targetTokens = wordToTokens(targetWord);
    const free = freeBestScore(lp, frames, classes);
    const forced = ctcForced(lp, frames, classes, tokenIds(targetTokens, this.tokenizer), this.tokenizer.blankIndex);
    const margin = (free - forced) / frames;
    const freeText = greedyText(lp, frames, classes, this.tokenizer, this.composer);
    const freeConf = this.freeConfidence(lp, frames, classes);

    const result: VerifyResult = {
      margin,
      decision: 'wrong',
      tau1,
      tau2,
      lambda,
      frames,
      freeText,
      freeConf,
      estimatedWritten: null,
      bestNeighborMargin: null,
      jamo: null,
      message: null,
    };

    // 절대적 읽기 신뢰도: 낙서/판독 불가 글씨 차단 (M은 상대 여유도라 낙서에서 무력)
    if (freeConf < lambda) {
      result.decision = 'illegible';
      result.message = '글자를 읽기 어려워요. 더 크고 반듯하게 써 볼까요?';
      return result;
    }
    if (margin <= tau1) {
      result.decision = 'correct';
      result.jamo = compare(targetWord, targetWord); // distance 0 (로그 일관성)
      result.message = result.jamo.message;
      return result;
    }
    if (margin <= tau2) {
      result.decision = 'unclear';
      result.message = '한 번만 더 또박또박 써서 찍어 볼까요?';
      return result;
    }
    result.decision = 'wrong';
    if (locateError) {
      // 1-자모 이웃 강제 정렬 — 최고 점수 이웃 = 학생이 쓴 것으로 추정
      let bestScore = -Infinity;
      let bestTokens: JamoToken[] | null = null;
      for (const v of neighborVariants(targetTokens)) {
        const s = ctcForced(lp, frames, classes, tokenIds(v, this.tokenizer), this.tokenizer.blankIndex);
        if (s > bestScore) {
          bestScore = s;
          bestTokens = v;
        }
      }
      result.bestNeighborMargin = (free - bestScore) / frames;
      if (bestTokens && result.bestNeighborMargin <= tau1) {
        // 판독 가능한 1-자모 오답 — 위치 특정 문구
        const est = composeTokens(bestTokens, this.composer);
        result.estimatedWritten = est;
        result.jamo = compare(est, targetWord); // 대조기 = 추정 낱말 vs 정답 차이 문구 생성
        result.message = result.jamo.message;
      } else {
        // 판독은 되지만 정답·이웃 모두에서 먼 큰 오류 — 대조기 강등 문구 스타일
        result.message = `'${targetWord}'를 다시 한 번 잘 보고 처음부터 써 볼까요?`;
      }
    }
    return result;
  }
}
