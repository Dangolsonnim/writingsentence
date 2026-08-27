# -*- coding: utf-8 -*-
"""받아쓰기 학습지 PDF 생성 (지시문 §5).
마커 좌표 = public/worksheets/DICT_0N_v1.json (gen_templates.mjs 단일 소스).
그림 단서 = scripts/cues/<scene_key>.png (앱 #print 페이지의 '단서 PNG 내려받기'로 추출
— 화면 연출과 동일한 three.js 렌더 정지컷). 없으면 자리 표시 사각형만 그린다.
정답 낱말 텍스트는 인쇄하지 않는다.

사용: python scripts/make_worksheets.py [out.pdf]
필요: pip install reportlab opencv-python pillow
"""
import io
import json
import os
import sys

import cv2
from PIL import Image
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdfcanvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = ["DICT_01_v1", "DICT_02_v1", "DICT_03_v1"]
CUE_DIR = os.path.join(ROOT, "scripts", "cues")


def load_font():
    for name, path in [("MalgunGothic", "C:/Windows/Fonts/malgun.ttf")]:
        if os.path.exists(path):
            pdfmetrics.registerFont(TTFont(name, path))
            return name
    return "Helvetica"


def marker_png(aruco_id, px=600):
    d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    img = cv2.aruco.generateImageMarker(d, aruco_id, px)
    buf = io.BytesIO()
    Image.fromarray(img).convert("RGB").save(buf, format="PNG")
    buf.seek(0)
    return buf


def draw_sheet(c, t, font, page_h_mm):
    def y_mm(v):  # top-left 좌표계 → PDF 좌표계
        return (page_h_mm - v) * mm

    c.setFont(font, 24)
    c.drawCentredString(105 * mm, y_mm(22), t["title"])
    c.setFont(font, 12)
    c.drawCentredString(105 * mm, y_mm(33), "학급 ______   이름 ______________")

    from reportlab.lib.utils import ImageReader

    for m in t["corner_markers"]:
        x, y = m["top_left_mm"]
        w, h = m["size_mm"]
        img = ImageReader(marker_png(m["aruco_id"]))
        c.drawImage(img, x * mm, y_mm(y + h), w * mm, h * mm)

    for s in t["note_slots"]:
        x, y, w, h = s["rect_mm"]
        c.setLineWidth(0.6 * mm)
        c.setStrokeColorRGB(0.2, 0.2, 0.2)
        c.roundRect(x * mm, y_mm(y + h), w * mm, h * mm, 2 * mm)
        c.setFont(font, 10)
        c.setFillColorRGB(0.33, 0.33, 0.33)
        c.drawString((x + 1.5) * mm, y_mm(y + 4.5), s["label"])
        c.setFillColorRGB(0, 0, 0)
        c.setLineWidth(0.35 * mm)
        c.setStrokeColorRGB(0.66, 0.66, 0.66)
        c.setDash(2, 2)
        c.line((x + w * 0.08) * mm, y_mm(y + h * 0.85), (x + w * 0.98) * mm, y_mm(y + h * 0.85))
        c.setDash()

        cx, cy, cw, ch = s["cue_rect_mm"]
        cue_path = os.path.join(CUE_DIR, f"{s['scene_key']}.png")
        c.setLineWidth(0.5 * mm)
        c.setStrokeColorRGB(1.0, 0.69, 0.0)
        c.roundRect(cx * mm, y_mm(cy + ch), cw * mm, ch * mm, 3 * mm)
        if os.path.exists(cue_path):
            c.drawImage(
                ImageReader(cue_path),
                (cx + 0.5) * mm,
                y_mm(cy + ch - 0.5),
                (cw - 1) * mm,
                (ch - 1) * mm,
                preserveAspectRatio=True,
                anchor="c",
            )
        else:
            c.setFont(font, 8)
            c.drawCentredString((cx + cw / 2) * mm, y_mm(cy + ch / 2), "(그림 단서)")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "받아쓰기_학습지_DICT01-03.pdf")
    font = load_font()
    first = json.load(open(os.path.join(ROOT, "public", "worksheets", TEMPLATES[0] + ".json"), encoding="utf-8"))
    pw, ph = first["page"]["size_mm"]
    c = pdfcanvas.Canvas(out, pagesize=(pw * mm, ph * mm))
    for tid in TEMPLATES:
        t = json.load(open(os.path.join(ROOT, "public", "worksheets", tid + ".json"), encoding="utf-8"))
        draw_sheet(c, t, font, t["page"]["size_mm"][1])
        c.showPage()
    c.save()
    print("wrote", out)


if __name__ == "__main__":
    main()
