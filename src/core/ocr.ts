/**
 * CRNN(jamo_no_null) ONNX OCR — OnnxOcrEngine.kt 동작 동등 포팅.
 * preprocess(H=32, grayscale, (x/255-0.5)/0.5, pad→4배수, 패딩값 -1) →
 * ORT 추론(images float32[1,1,32,W], image_widths int64[1]) →
 * logits [1,T,620] 그리디 CTC → 자모결합.
 */
import { CrnnTokenizer, HangulComposer } from './hangul';
import { resizeBilinear, type Raster } from './raster';

export interface OcrOutput {
  text: string;
  confidence: number;
  frames: number;
  timeMs: number;
}

/** ONNX 세션 추상화 — 브라우저(onnxruntime-web)와 Node(onnxruntime-node) 공용 */
export interface OcrRunner {
  /** returns logits flat array + dims [1,T,C] */
  run(images: Float32Array, dims: number[], imageWidths: BigInt64Array): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

export interface OcrPreprocessResult {
  data: Float32Array;
  width: number; // 리사이즈 폭(패딩 전)
  padded: number; // 4배수 패딩 폭
  height: number;
}

export const OCR_HEIGHT = 32;

/** RGBA 래스터 → 모델 입력 텐서 (HangulComposer.kt/OnnxOcrEngine.kt recognize()와 동일) */
export function preprocessForOcr(src: Raster): OcrPreprocessResult {
  const h = OCR_HEIGHT;
  let w = Math.round((h * src.width) / Math.max(1, src.height));
  w = Math.min(512, Math.max(8, w));
  const scaled = resizeBilinear(src, w, h);
  const padded = Math.floor((w + 3) / 4) * 4;
  const data = new Float32Array(padded * h).fill(-1.0); // 패딩(0)의 정규화값 = -1
  const d = scaled.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const gray = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255.0;
      data[y * padded + x] = (gray - 0.5) / 0.5;
    }
  }
  return { data, width: w, padded, height: h };
}

/** CTC greedy decode → emitted ids + emitted softmax max probs */
export function ctcGreedy(
  logits: Float32Array,
  frames: number,
  classes: number,
  blank: number
): { ids: number[]; probs: number[] } {
  const ids: number[] = [];
  const probs: number[] = [];
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    const off = t * classes;
    let best = 0;
    let bestv = logits[off];
    for (let k = 1; k < classes; k++) {
      if (logits[off + k] > bestv) {
        bestv = logits[off + k];
        best = k;
      }
    }
    if (best !== blank && best !== prev) {
      ids.push(best);
      probs.push(softmaxAt(logits, off, classes, best));
    }
    prev = best;
  }
  return { ids, probs };
}

function softmaxAt(logits: Float32Array, off: number, classes: number, idx: number): number {
  let mx = logits[off];
  for (let k = 1; k < classes; k++) if (logits[off + k] > mx) mx = logits[off + k];
  let sum = 0;
  for (let k = 0; k < classes; k++) sum += Math.exp(logits[off + k] - mx);
  return Math.exp(logits[off + idx] - mx) / sum;
}

function geoMean(probs: number[]): number {
  if (probs.length === 0) return 0;
  let s = 0;
  for (const p of probs) s += Math.log(Math.max(p, 1e-8));
  return Math.exp(s / probs.length);
}

export class OcrEngine {
  private composer: HangulComposer;

  constructor(
    private runner: OcrRunner,
    private tokenizer: CrnnTokenizer
  ) {
    this.composer = new HangulComposer(tokenizer.vocab);
  }

  async recognize(src: Raster): Promise<OcrOutput> {
    const t0 = Date.now();
    const pre = preprocessForOcr(src);
    const res = await this.runner.run(
      pre.data,
      [1, 1, pre.height, pre.padded],
      BigInt64Array.from([BigInt(pre.padded)])
    );
    // logits [1,T,C]
    const dims = res.dims;
    const frames = dims.length === 3 ? dims[1] : 0;
    const classes = dims.length === 3 ? dims[2] : this.tokenizer.size;
    let text = '';
    let confidence = 0;
    if (frames > 0) {
      const { ids, probs } = ctcGreedy(res.data, frames, classes, this.tokenizer.blankIndex);
      text = this.composer.compose(ids.map((i) => this.tokenizer.tokenAt(i)));
      confidence = geoMean(probs);
    }
    return { text, confidence, frames, timeMs: Date.now() - t0 };
  }
}
