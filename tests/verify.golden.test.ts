/**
 * 검증 모드 동등성 골든 — 도메인평가 실손글씨 크롭 36장 × 12낱말 여유도 M 재현(±0.01).
 * 기준: 도메인평가/검증여유도_골든36.csv (지시문 §3 / 도메인평가_결과.md §5).
 * 추가 확인: τ1=0.25 기준 정답 인정 36/36, 오답 오인정 ≤ 1%(396쌍 중 ≤4).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-node';
import { CrnnTokenizer } from '../src/core/hangul';
import { logSoftmax, preprocessForVerify, SpellVerifier } from '../src/core/verify';
import type { Raster } from '../src/core/raster';
import { parseCsv } from './csv';

const dir = join(__dirname, 'fixtures', 'verify');
const rows = parseCsv(readFileSync(join(dir, '검증여유도_골든36.csv'), 'utf-8'));
const WORDS = ['나무', '오리', '나비', '바나나', '사과', '구름', '연필', '눈사람', '딸기', '토끼', '돼지', '무지개'];

function loadPng(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

describe('검증 모드(강제 정렬 여유도) 골든 36', () => {
  it('M 재현 ±0.01 + 운영점(τ1=0.25) 분리 확인', async () => {
    const session = await ort.InferenceSession.create(
      join(__dirname, '..', 'public', 'models', 'crnn.onnx'),
      { intraOpNumThreads: 1, interOpNumThreads: 1 }
    );
    const tokenizer = CrnnTokenizer.fromJson(
      readFileSync(join(__dirname, '..', 'public', 'models', 'tokenizer.json'), 'utf-8')
    );
    const verifier = new SpellVerifier(
      {
        async run(data, dims, imageWidths) {
          const out = await session.run({
            images: new ort.Tensor('float32', data, dims),
            image_widths: new ort.Tensor('int64', imageWidths, [1]),
          });
          const first = out[session.outputNames[0]];
          return { data: first.data as Float32Array, dims: first.dims };
        },
      },
      tokenizer
    );

    let maxErr = 0;
    let cells = 0;
    let correctAccepted = 0;
    let wrongAccepted = 0;
    let wrongPairs = 0;
    const errors: string[] = [];
    for (const row of rows) {
      const raster = loadPng(join(dir, 'crops', row.file));
      const pre = preprocessForVerify(raster);
      const out = await session.run({
        images: new ort.Tensor('float32', pre.data, [1, 1, 32, pre.padded]),
        image_widths: new ort.Tensor('int64', BigInt64Array.from([BigInt(pre.padded)]), [1]),
      });
      const logits = out[session.outputNames[0]];
      const [, frames, classes] = logits.dims;
      expect(frames).toBe(Number(row.frames));
      const lp = logSoftmax(logits.data as Float32Array, frames, classes);
      for (const w of WORDS) {
        const m = verifier.marginFor(lp, frames, classes, w);
        const ref = Number(row[`M_${w}`]);
        const err = Math.abs(m - ref);
        cells++;
        if (err > maxErr) maxErr = err;
        if (err > 0.01) errors.push(`${row.file} ${w}: web=${m.toFixed(4)} ref=${ref}`);
        if (w === row.true_word) {
          if (m <= 0.25) correctAccepted++;
        } else {
          wrongPairs++;
          if (m <= 0.25) wrongAccepted++;
        }
      }
    }
    console.log(
      `M 재현: ${cells}셀, 최대 오차 ${maxErr.toFixed(4)} | τ1=0.25: 정답 인정 ${correctAccepted}/36, 오답 오인정 ${wrongAccepted}/${wrongPairs} (${((100 * wrongAccepted) / wrongPairs).toFixed(1)}%)`
    );
    if (errors.length) console.log('오차 초과:\n  ' + errors.slice(0, 10).join('\n  '));
    expect(errors.length).toBe(0);
    expect(correctAccepted).toBe(36);
    expect(wrongAccepted / wrongPairs).toBeLessThanOrEqual(0.011);
  }, 300000);
});
