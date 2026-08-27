/**
 * 공백 감지(잉크 비율) — SlotInkAnalyzer.kt analyzePixels/componentStats 동작 동등 포팅.
 * 파라미터(임계 145, mean-22, blankScore 0.82/0.35, 면적≥4 등) 원본과 동일.
 */
import { lumaAt, type Raster } from './raster';

export interface BlankMetrics {
  localBlank: boolean;
  blankScore: number;
  blankReason: string;
  darkRatio: number;
  inkRatio: number;
  stdDev: number;
  componentCount: number;
  largestComponentArea: number;
}

export function analyzeBlank(crop: Raster): BlankMetrics {
  const w = Math.max(1, crop.width);
  const size = w * Math.max(1, crop.height);
  const gray = new Int32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const g = Math.trunc(lumaAt(crop.data, i * 4));
    gray[i] = g;
    sum += g;
  }
  const mean = sum / size;
  let sq = 0;
  let dark = 0;
  let ink = 0;
  const adaptiveThreshold = Math.min(220, Math.max(95, mean - 22));
  for (let i = 0; i < size; i++) {
    const g = gray[i];
    const d = g - mean;
    sq += d * d;
    if (g < 145) dark++;
    if (g < adaptiveThreshold && g < 220) ink++;
  }
  const darkRatio = dark / size;
  const inkRatio = ink / size;
  const stdDev = Math.sqrt(sq / size);
  const height = Math.max(1, Math.floor(size / w));
  const comp = componentStats(gray, w, height, Math.min(220, Math.max(85, Math.trunc(adaptiveThreshold))));
  const nonBlankEvidence = Math.min(
    1,
    Math.max(
      inkRatio / 0.012,
      stdDev / 18.0,
      comp.largestComponentArea / 90.0,
      comp.count / 3.0
    )
  );
  const blankScore = Math.min(1, Math.max(0, 1 - nonBlankEvidence));
  const localBlank = blankScore >= 0.82;
  const reason =
    blankScore >= 0.82
      ? 'low_ink_strong_blank'
      : blankScore >= 0.7
        ? 'low_ink_likely_blank'
        : blankScore <= 0.35
          ? 'ink_detected_likely_written'
          : 'ink_detected';
  return {
    localBlank,
    blankScore,
    blankReason: reason,
    darkRatio,
    inkRatio,
    stdDev,
    componentCount: comp.count,
    largestComponentArea: comp.largestComponentArea,
  };
}

function componentStats(
  gray: Int32Array,
  width: number,
  height: number,
  threshold: number
): { count: number; largestComponentArea: number } {
  const visited = new Uint8Array(gray.length);
  let count = 0;
  let largest = 0;
  const queue = new Int32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    if (visited[i] || gray[i] >= threshold) continue;
    let head = 0;
    let tail = 0;
    let area = 0;
    visited[i] = 1;
    queue[tail++] = i;
    while (head < tail) {
      const cur = queue[head++];
      area++;
      const x = cur % width;
      const y = Math.floor(cur / width);
      const push = (nx: number, ny: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const ni = ny * width + nx;
        if (!visited[ni] && gray[ni] < threshold) {
          visited[ni] = 1;
          queue[tail++] = ni;
        }
      };
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }
    if (area >= 4) {
      count++;
      if (area > largest) largest = area;
    }
  }
  return { count, largestComponentArea: largest };
}
