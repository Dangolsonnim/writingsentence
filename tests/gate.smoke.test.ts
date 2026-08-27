/**
 * 게이트 v1 스모크 — 정자/낙서 각 5장 등급 서열 확인 (지시문 §8-3).
 * 표본: 배포2_게이트/평정확대_v1 600장 중 gate_score 양극단 5+5장
 * (neat = 점수 최하위(양호), scribble = 최상위(불량)).
 * 확인: ① 낙서 평균 등급 < 정자 평균 등급 ② 개별 서열 겹침 없음(최소 정자 ≥ 최대 낙서).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-node';
import { GateEngine, type GateRunner } from '../src/core/gate';
import type { Raster } from '../src/core/raster';

const dir = join(__dirname, 'fixtures', 'gate');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as {
  neat: Array<{ file: string; ref_gate_score: number }>;
  scribble: Array<{ file: string; ref_gate_score: number }>;
};

function loadPng(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

describe('gate v1 smoke: 정자 vs 낙서 서열', () => {
  it('scribble grades < neat grades', async () => {
    const session = await ort.InferenceSession.create(
      join(__dirname, '..', 'public', 'models', 'gate_v1.onnx'),
      { intraOpNumThreads: 1, interOpNumThreads: 1 }
    );
    const inputName = session.inputNames[0];
    const runner: GateRunner = {
      async run(input, dims) {
        const out = await session.run({ [inputName]: new ort.Tensor('float32', input, dims) });
        const first = out[session.outputNames[0]];
        return { data: first.data as Float32Array, dims: first.dims };
      },
    };
    const engine = new GateEngine(runner);

    const grade = async (file: string) => engine.classify(loadPng(join(dir, file)));
    const neat = [];
    const scribble = [];
    for (const m of manifest.neat) neat.push({ file: m.file, ...(await grade(m.file)) });
    for (const m of manifest.scribble) scribble.push({ file: m.file, ...(await grade(m.file)) });

    console.log('정자:', neat.map((r) => `${r.file}=g${r.grade}(s${r.score.toFixed(3)})`).join(' '));
    console.log('낙서:', scribble.map((r) => `${r.file}=g${r.grade}(s${r.score.toFixed(3)})`).join(' '));

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const neatAvg = avg(neat.map((r) => r.grade));
    const scribbleAvg = avg(scribble.map((r) => r.grade));
    console.log(`평균 등급: 정자 ${neatAvg.toFixed(2)} vs 낙서 ${scribbleAvg.toFixed(2)}`);
    expect(scribbleAvg).toBeLessThan(neatAvg);
    expect(Math.min(...neat.map((r) => r.grade))).toBeGreaterThanOrEqual(
      Math.max(...scribble.map((r) => r.grade))
    );
  }, 120000);
});
