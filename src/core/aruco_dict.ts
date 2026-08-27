/**
 * DICT_4X4_50 비트 패턴 (OpenCV cv2.aruco 기준 덤프, 16비트 = 4x4 row-major MSB-first, 1=흰 칸).
 * 인쇄(학습지 마커 SVG)용 — 검출은 OpenCV.js가 담당.
 */
export const DICT_4X4_50_CODES: number[] = [
  46386, 3994, 13101, 39238, 21662, 31181, 40494, 50418, 65242, 53078, 63889, 4519, 3767, 10767,
  9393, 9790, 18021, 26112, 27742, 30383, 34443, 45099, 52437, 56706, 65095, 38001, 44260, 42324,
  8483, 13423, 17429, 22450, 40655, 61643, 2222, 2345, 6261, 1279, 3574, 7258, 5912, 10792, 12940,
  14514, 9448, 12011, 11583, 19300, 20526, 20499,
];

/** 마커 id → 6x6 모듈(테두리 포함) SVG 문자열. sizeMm 물리 크기. */
export function arucoMarkerSvg(id: number, sizeMm: number): string {
  const code = DICT_4X4_50_CODES[id];
  if (code === undefined) throw new Error(`aruco id out of range: ${id}`);
  const cell = sizeMm / 6;
  let rects = `<rect x="0" y="0" width="${sizeMm}" height="${sizeMm}" fill="#000"/>`;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const bit = (code >> (15 - (r * 4 + c))) & 1;
      if (bit === 1) {
        rects += `<rect x="${((c + 1) * cell).toFixed(3)}" y="${((r + 1) * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="#fff"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeMm}mm" height="${sizeMm}mm" viewBox="0 0 ${sizeMm} ${sizeMm}" shape-rendering="crispEdges">${rects}</svg>`;
}
