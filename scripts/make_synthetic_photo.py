# -*- coding: utf-8 -*-
"""합성 학습지 사진 생성 — 판정 분기 시연/E2E용.
템플릿 JSON(단일 소스)에서 A4 이미지를 렌더하고, 지정 칸에 손글씨풍 텍스트를 넣고
퍼스펙티브 워프+노이즈로 '촬영된 사진'을 흉내 낸다.

사용: python scripts/make_synthetic_photo.py <template_idx 0-2> <slot_idx 0-3|-1> <text|BLANK|SCRIBBLE|REALCROP|ALL> <out.png> [--messy] [--fs=..] [--font=..]
  slot_idx=-1 + text=ALL → 모든 칸에 템플릿의 정답 낱말 기입 (전체 시트 E2E용)
"""
import json
import os
import sys
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

PPM = 8  # px per mm (A4 210x297 -> 1680x2376)


def render_page(template, slot_idx, text, messy=False):
    w_mm, h_mm = template["page"]["size_mm"]
    W, H = int(w_mm * PPM), int(h_mm * PPM)
    img = Image.new("RGB", (W, H), (238, 233, 226))  # 촬영된 종이 톤(게이트 도메인)
    draw = ImageDraw.Draw(img)

    # ArUco corner markers
    d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    for m in template["corner_markers"]:
        size_px = int(m["size_mm"][0] * PPM)
        marker = cv2.aruco.generateImageMarker(d, m["aruco_id"], size_px)
        marker_rgb = Image.fromarray(cv2.cvtColor(marker, cv2.COLOR_GRAY2RGB))
        img.paste(marker_rgb, (int(m["top_left_mm"][0] * PPM), int(m["top_left_mm"][1] * PPM)))

    # slots
    for i, s in enumerate(template["note_slots"]):
        x, y, w, h = [v * PPM for v in s["rect_mm"]]
        draw.rounded_rectangle([x, y, x + w, y + h], radius=2 * PPM, outline=(51, 51, 51), width=max(2, int(0.6 * PPM)))
        draw.text((x + 1.5 * PPM, y + 1 * PPM), s["label"], fill=(85, 85, 85))
        if slot_idx == -1 and text == "ALL":
            slot_text = s["target_word"]
        elif i == slot_idx:
            slot_text = text
        else:
            slot_text = "BLANK"
        if slot_text not in ("BLANK",):
            if slot_text == "REALCROP":
                # 실물 손글씨 크롭(게이트 4등급 표본)을 칸 내부에 합성 — 게이트 통과 경로 시연용
                real = Image.open(os.path.join("tests", "fixtures", "gate", "Q123.png")).convert("RGB")
                inner_w, inner_h = int(w * 0.86), int(h * 0.7)
                scale = min(inner_w / real.width, inner_h / real.height)
                real = real.resize((int(real.width * scale), int(real.height * scale)), Image.BICUBIC)
                img.paste(real, (int(x + w * 0.07), int(y + h * 0.18)))
            elif slot_text == "SCRIBBLE":
                rng = np.random.default_rng(7)
                pts = []
                cx, cy = x + w * 0.5, y + h * 0.55
                for k in range(60):
                    cx += rng.normal(0, w * 0.045)
                    cy += rng.normal(0, h * 0.16)
                    cx = min(max(cx, x + w * 0.12), x + w * 0.95)
                    cy = min(max(cy, y + h * 0.25), y + h * 0.9)
                    pts.append((cx, cy))
                draw.line(pts, fill=(60, 60, 70), width=max(2, int(0.55 * PPM)))
            else:
                # 손글씨풍(학교안심 산뜻돋움 L) + 연필 톤.
                # 배치는 OCR 크롭(ocr_wide: 0.08~0.98w × 0.18~0.92h) 기준 fs=0.74·y=0.22·x=0.05
                # — CRNN이 12낱말 전부 정확히 읽는 실측 설정.
                crop_h = h * 0.74
                crop_w = w * 0.9
                fs_ratio = 0.62
                font_path = "C:/Windows/Fonts/HakgyoansimSantteutdotumL.ttf"
                for a in sys.argv:
                    if a.startswith("--fs="):
                        fs_ratio = float(a.split("=")[1])
                    if a.startswith("--font="):
                        font_path = a.split("=", 1)[1]
                fs = int(crop_h * fs_ratio)
                try:
                    font = ImageFont.truetype(font_path, fs)
                except OSError:
                    font = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", fs)
                txt_img = Image.new("RGBA", (int(w), int(h)), (0, 0, 0, 0))
                td = ImageDraw.Draw(txt_img)
                td.text((w * 0.08 + crop_w * 0.05, h * 0.18 + crop_h * 0.18), slot_text, font=font, fill=(72, 70, 82, 255))
                img.paste(txt_img, (int(x), int(y)), txt_img)

    arr = np.array(img)
    if messy:
        arr = cv2.GaussianBlur(arr, (5, 5), 1.2)
    return arr


def photo_warp(page, out_w=2000):
    H, W = page.shape[:2]
    # 촬영 배경(책상)
    margin = 0.06
    dst_w, dst_h = out_w, int(out_w * H / W)
    canvas = np.full((int(dst_h * (1 + margin * 2)), int(dst_w * (1 + margin * 2)), 3), (168, 148, 122), np.uint8)
    ch, cw = canvas.shape[:2]
    # 살짝 기운 퍼스펙티브
    jitter = 0.025
    dst_pts = np.float32(
        [
            [cw * (margin + jitter * 0.7), ch * (margin + jitter)],
            [cw * (1 - margin - jitter * 0.3), ch * (margin + jitter * 1.6)],
            [cw * (1 - margin - jitter), ch * (1 - margin - jitter * 0.5)],
            [cw * (margin + jitter * 1.4), ch * (1 - margin - jitter * 1.2)],
        ]
    )
    src_pts = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    out = cv2.warpPerspective(page, M, (cw, ch), borderMode=cv2.BORDER_TRANSPARENT, dst=canvas.copy())
    # 캡처 도메인 근사: 카메라 블러 + 조명 그라데이션 + 센서 노이즈 + JPEG 아티팩트
    out = cv2.GaussianBlur(out, (3, 3), 0.9)
    yy = np.linspace(0.9, 1.04, ch)[:, None, None]
    xx = np.linspace(0.97, 1.02, cw)[None, :, None]
    out = np.clip(out.astype(np.float32) * yy * xx, 0, 255)
    noise = np.random.default_rng(3).normal(0, 4.0, out.shape)
    out = np.clip(out + noise, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", cv2.cvtColor(out, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
    if ok:
        out = cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    return out


def main():
    tpl_idx = int(sys.argv[1])
    slot_idx = int(sys.argv[2])
    text = sys.argv[3]
    out_path = sys.argv[4]
    messy = "--messy" in sys.argv
    tid = f"DICT_0{tpl_idx + 1}_v1"
    with open(f"public/worksheets/{tid}.json", encoding="utf-8") as f:
        template = json.load(f)
    page = render_page(template, slot_idx, text, messy)
    photo = photo_warp(page)
    cv2.imwrite(out_path, cv2.cvtColor(photo, cv2.COLOR_RGB2BGR))
    print(f"wrote {out_path} ({photo.shape[1]}x{photo.shape[0]}) template={tid} slot={slot_idx} text={text}")


if __name__ == "__main__":
    main()
