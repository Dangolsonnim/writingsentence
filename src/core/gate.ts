/**
 * 글씨 품질 게이트 v1 — GateClassifier.kt 동작 동등 포팅.
 * 입력 RGB 96×320 스트레치(종횡비 무시, 양선형), /255 → ImageNet 정규화, NCHW.
 * 출력 logits float32[N,5]. p_k = sigmoid(logit_k).
 *  - 등급(grade) = p_k > 0.5 인 k의 개수 (0~5)
 *  - 연속 점수(score) = 1 − sigmoid(logit[2]) = 1 − P(등급≥3)
 * 통과 = 등급 ≥ 임계 (class_group A=4 / B=3, 지시문 §3).
 */
import { resizeBilinear, type Raster } from './raster';

export const GATE_MODEL_VERSION = 'v1';
export const GATE_H = 96;
export const GATE_W = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface GateResult {
  grade: number;
  score: number;
}

export interface GateRunner {
  /** input float32[1,3,96,320] → logits float32[1,5] */
  run(input: Float32Array, dims: number[]): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

export function preprocessForGate(src: Raster): Float32Array {
  const scaled = resizeBilinear(src, GATE_W, GATE_H);
  const plane = GATE_H * GATE_W;
  const out = new Float32Array(3 * plane);
  const d = scaled.data;
  for (let y = 0; y < GATE_H; y++) {
    for (let x = 0; x < GATE_W; x++) {
      const o = y * GATE_W + x;
      const p = o * 4;
      out[o] = (d[p] / 255 - MEAN[0]) / STD[0];
      out[plane + o] = (d[p + 1] / 255 - MEAN[1]) / STD[1];
      out[2 * plane + o] = (d[p + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class GateEngine {
  constructor(private runner: GateRunner) {}

  async classify(src: Raster): Promise<GateResult> {
    const input = preprocessForGate(src);
    const res = await this.runner.run(input, [1, 3, GATE_H, GATE_W]);
    const row = res.data; // [1,5]
    let grade = 0;
    for (let k = 0; k < 5; k++) if (sigmoid(row[k]) > 0.5) grade++;
    const score = 1 - sigmoid(row[2]); // 1 − P(등급≥3)
    return { grade, score };
  }
}
