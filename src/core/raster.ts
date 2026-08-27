/**
 * 브라우저/Node 공용 RGBA 래스터와 리사이즈.
 * Android Bitmap.createScaledBitmap(filter=true)와 동일하게 양선형(bilinear) 보간을 쓴다.
 * (OCR 동등성: 리사이즈 보간이 안드로이드 기기 OCR 원문과의 일치율을 좌우 — 순수 TS로
 *  구현해 canvas 구현 차이를 배제한다.)
 */
export interface Raster {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export function rasterFromImageData(img: ImageData): Raster {
  return { data: img.data, width: img.width, height: img.height };
}

/** 양선형 리사이즈 (픽셀 중심 정렬: src = (dst+0.5)*scale-0.5) */
export function resizeBilinear(src: Raster, dw: number, dh: number): Raster {
  if (src.width === dw && src.height === dh) return src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = src.width / dw;
  const sy = src.height / dh;
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    let y0 = Math.floor(fy);
    let wy = fy - y0;
    if (y0 < 0) {
      y0 = 0;
      wy = 0;
    }
    let y1 = y0 + 1;
    if (y1 > sh - 1) {
      y1 = sh - 1;
      if (y0 > sh - 1) y0 = sh - 1;
    }
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      let x0 = Math.floor(fx);
      let wx = fx - x0;
      if (x0 < 0) {
        x0 = 0;
        wx = 0;
      }
      let x1 = x0 + 1;
      if (x1 > sw - 1) {
        x1 = sw - 1;
        if (x0 > sw - 1) x0 = sw - 1;
      }
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * wx;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * wx;
        out[o + ch] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return { data: out, width: dw, height: dh };
}

/** 부분 영역 잘라내기 (정수 픽셀 rect) */
export function cropRaster(src: Raster, x: number, y: number, w: number, h: number): Raster {
  const cx = Math.max(0, Math.min(src.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(src.height - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(src.width - cx, Math.round(w)));
  const ch = Math.max(1, Math.min(src.height - cy, Math.round(h)));
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcOff = ((cy + row) * src.width + cx) * 4;
    out.set(src.data.subarray(srcOff, srcOff + cw * 4), row * cw * 4);
  }
  return { data: out, width: cw, height: ch };
}

/** 그레이스케일 luma (0..255, 반올림 없이 float) — Android Color 가중치와 동일 */
export function lumaAt(d: Uint8ClampedArray, idx: number): number {
  return d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
}
