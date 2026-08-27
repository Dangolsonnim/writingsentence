/**
 * ArUco DICT_4X4_50 검출 + 호모그래피 칸 크롭 — OpenCV.js.
 * 동작 동등 이식 원본: MarkerAlignedSlotCropper.kt (호모그래피는 마커 중심 4점 기준,
 * 크롭 프로파일 인셋·pixelsPerMm(5..14)·최소 크기 동일).
 */
import cv from '@techstark/opencv-js';
import type { Raster } from './raster';

/** @techstark/opencv-js 타입 정의에 빠진 ArUco(objdetect) API 표면 */
interface ArucoDetectorLike {
  detectMarkers(image: cv.Mat, corners: cv.MatVector, ids: cv.Mat): void;
  delete(): void;
}
interface CvAruco {
  DICT_4X4_50: number;
  getPredefinedDictionary(dict: number): { delete(): void };
  aruco_DetectorParameters: new () => { delete(): void };
  aruco_RefineParameters: new (minRepDistance: number, errorCorrectionRate: number, checkAllOrders: boolean) => {
    delete(): void;
  };
  aruco_ArucoDetector: new (
    dictionary: { delete(): void },
    params: { delete(): void },
    refine: { delete(): void }
  ) => ArucoDetectorLike;
}
const cvAruco = cv as unknown as CvAruco;

let cvReadyPromise: Promise<void> | null = null;

export function initCv(): Promise<void> {
  if (!cvReadyPromise) {
    cvReadyPromise = new Promise<void>((resolve) => {
      const anyCv = cv as unknown as Record<string, unknown>;
      if (typeof anyCv.Mat === 'function') {
        resolve();
        return;
      }
      (anyCv as { onRuntimeInitialized?: () => void }).onRuntimeInitialized = () => resolve();
    });
  }
  return cvReadyPromise;
}

export interface DetectedMarker {
  id: number;
  corners: Array<{ x: number; y: number }>; // TL,TR,BR,BL (marker 기준)
  centerX: number;
  centerY: number;
}

function rasterToMat(src: Raster): cv.Mat {
  return cv.matFromImageData({
    data: src.data,
    width: src.width,
    height: src.height,
  } as unknown as ImageData);
}

export function detectArucoMarkers(src: Raster): DetectedMarker[] {
  const rgba = rasterToMat(src);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const dict = cvAruco.getPredefinedDictionary(cvAruco.DICT_4X4_50);
  const params = new cvAruco.aruco_DetectorParameters();
  const refine = new cvAruco.aruco_RefineParameters(10, 3, true);
  const detector = new cvAruco.aruco_ArucoDetector(dict, params, refine);
  const cornersVec = new cv.MatVector();
  const ids = new cv.Mat();
  const out: DetectedMarker[] = [];
  try {
    detector.detectMarkers(gray, cornersVec, ids);
    const n = ids.rows;
    for (let i = 0; i < n; i++) {
      const id = ids.data32S[i];
      const c = cornersVec.get(i); // 1x4 CV_32FC2
      const pts: Array<{ x: number; y: number }> = [];
      for (let k = 0; k < 4; k++) {
        pts.push({ x: c.data32F[k * 2], y: c.data32F[k * 2 + 1] });
      }
      c.delete();
      const centerX = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
      const centerY = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
      out.push({ id, corners: pts, centerX, centerY });
    }
  } finally {
    rgba.delete();
    gray.delete();
    cornersVec.delete();
    ids.delete();
    detector.delete();
    params.delete();
    refine.delete();
    dict.delete();
  }
  return out;
}

/** 3x3 호모그래피 (page mm → image px), row-major 9원소 */
export type Homography = number[];

export function homographyFromPoints(
  srcMm: Array<{ x: number; y: number }>,
  dstPx: Array<{ x: number; y: number }>
): Homography {
  const srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, srcMm.flatMap((p) => [p.x, p.y]));
  const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, dstPx.flatMap((p) => [p.x, p.y]));
  const h = cv.getPerspectiveTransform(srcMat, dstMat);
  const out = Array.from(h.data64F.length ? h.data64F : h.data32F) as number[];
  srcMat.delete();
  dstMat.delete();
  h.delete();
  return out;
}

export function projectPoint(h: Homography, x: number, y: number): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

export interface RectMm {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type CropProfile = 'full' | 'blank_analysis' | 'ocr_wide';

export interface SlotRectSpec {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/** MarkerAlignedSlotCropper.slotRectMm 동등 */
export function slotRectMm(
  slot: SlotRectSpec,
  pageWmm: number,
  pageHmm: number,
  profile: CropProfile
): RectMm {
  switch (profile) {
    case 'blank_analysis':
      return {
        left: slot.xMm + slot.wMm * 0.16,
        top: slot.yMm + slot.hMm * 0.32,
        right: slot.xMm + slot.wMm * 0.96,
        bottom: slot.yMm + slot.hMm * 0.82,
      };
    case 'ocr_wide':
      return {
        left: slot.xMm + slot.wMm * 0.08,
        top: slot.yMm + slot.hMm * 0.18,
        right: slot.xMm + slot.wMm * 0.98,
        bottom: slot.yMm + slot.hMm * 0.92,
      };
    case 'full': {
      const pad = 2.5;
      return {
        left: Math.max(0, slot.xMm - pad),
        top: Math.max(0, slot.yMm - pad),
        right: Math.min(pageWmm, slot.xMm + slot.wMm + pad),
        bottom: Math.min(pageHmm, slot.yMm + slot.hMm + pad),
      };
    }
  }
}

/**
 * 호모그래피로 page-mm rect를 정면 뷰 크롭으로 워핑.
 * pixelsPerMm = (image.width / pageWmm).coerceIn(5,14) — 원본과 동일.
 */
export function warpRectCrop(
  src: Raster,
  h: Homography,
  rect: RectMm,
  pageWmm: number
): Raster | null {
  const rw = rect.right - rect.left;
  const rh = rect.bottom - rect.top;
  if (rw <= 1 || rh <= 1) return null;
  const pixelsPerMm = Math.min(14, Math.max(5, src.width / pageWmm));
  const outW = Math.max(48, Math.round(rw * pixelsPerMm));
  const outH = Math.max(24, Math.round(rh * pixelsPerMm));

  // page-mm 사각형의 이미지 좌표 4점 → 출력 사각형으로 퍼스펙티브 워핑(양선형)
  const tl = projectPoint(h, rect.left, rect.top);
  const tr = projectPoint(h, rect.right, rect.top);
  const br = projectPoint(h, rect.right, rect.bottom);
  const bl = projectPoint(h, rect.left, rect.bottom);
  for (const p of [tl, tr, br, bl]) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }
  const srcMat = rasterToMat(src);
  const quad = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const m = cv.getPerspectiveTransform(quad, dst);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(
      srcMat,
      out,
      m,
      new cv.Size(outW, outH),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar()
    );
    const data = new Uint8ClampedArray(out.data); // RGBA
    return { data, width: outW, height: outH };
  } finally {
    srcMat.delete();
    quad.delete();
    dst.delete();
    m.delete();
    out.delete();
  }
}
