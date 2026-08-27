/** 브라우저(onnxruntime-web WASM) 세션 생성 — 게이트 v1 + CRNN OCR. 전부 로컬 추론. */
import * as ort from 'onnxruntime-web/wasm';
import { CrnnTokenizer } from './hangul';
import { GateEngine, type GateRunner } from './gate';
import { OcrEngine, type OcrRunner } from './ocr';

export interface Engines {
  gate: GateEngine;
  ocr: OcrEngine;
  tokenizer: CrnnTokenizer;
}

let enginesPromise: Promise<Engines> | null = null;

export function loadEngines(onProgress?: (msg: string) => void): Promise<Engines> {
  if (!enginesPromise) enginesPromise = doLoad(onProgress);
  return enginesPromise;
}

async function doLoad(onProgress?: (msg: string) => void): Promise<Engines> {
  // COOP/COEP 헤더 불요(단일 스레드 SIMD). WASM 경로는 번들 자산(import.meta.url) 자동 해석.
  ort.env.wasm.numThreads = 1;

  onProgress?.('글씨 판정 모델 준비 중…');
  const gateSession = await ort.InferenceSession.create(
    `${import.meta.env.BASE_URL}models/gate_v1.onnx`,
    { executionProviders: ['wasm'] }
  );
  onProgress?.('글자 인식 모델 준비 중… (첫 실행은 시간이 걸려요)');
  const ocrSession = await ort.InferenceSession.create(
    `${import.meta.env.BASE_URL}models/crnn.onnx`,
    { executionProviders: ['wasm'] }
  );
  onProgress?.('문자표 준비 중…');
  const tkRes = await fetch(`${import.meta.env.BASE_URL}models/tokenizer.json`);
  const tokenizer = CrnnTokenizer.fromJson(await tkRes.text());

  const gateInput = gateSession.inputNames[0];
  const gateRunner: GateRunner = {
    async run(input, dims) {
      const out = await gateSession.run({ [gateInput]: new ort.Tensor('float32', input, dims) });
      const first = out[gateSession.outputNames[0]];
      return { data: first.data as Float32Array, dims: first.dims };
    },
  };
  const ocrRunner: OcrRunner = {
    async run(images, dims, imageWidths) {
      const out = await ocrSession.run({
        images: new ort.Tensor('float32', images, dims),
        image_widths: new ort.Tensor('int64', imageWidths, [1]),
      });
      const first = out[ocrSession.outputNames[0]];
      return { data: first.data as Float32Array, dims: first.dims };
    },
  };
  return {
    gate: new GateEngine(gateRunner),
    ocr: new OcrEngine(ocrRunner, new CrnnTokenizer(tokenizer.vocab, tokenizer.blankIndex)),
    tokenizer,
  };
}
