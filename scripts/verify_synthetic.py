# -*- coding: utf-8 -*-
"""합성 사진 사전 검증 — 웹 파이프라인 미러(파이썬): decodeScaled(2400) → ArUco 검출 →
호모그래피 → ocr_wide 크롭 → 게이트 등급 + CRNN 판독. 픽스처 준비 전용 도구.
사용: python scripts/verify_synthetic.py public/dev/w_t0s0.png 나무 [slot_idx]
      python scripts/verify_synthetic.py --all   (12낱말 일괄)
"""
import json
import sys
import unicodedata

import cv2
import numpy as np
import onnxruntime as ort

sys.stdout.reconfigure(encoding="utf-8")

TK = json.load(open("public/models/tokenizer.json", encoding="utf-8"))
VOCAB = TK["vocab"]
BLANK = VOCAB.index("<BLANK>")
CHO_I, JUNG_I, JONG_I = {}, {}, {}
_c = _j = 0
_t = 1
for tok in VOCAB:
    if tok.startswith("CHO_"):
        CHO_I[tok[4:]] = _c
        _c += 1
    elif tok.startswith("JUNG_"):
        JUNG_I[tok[5:]] = _j
        _j += 1
    elif tok.startswith("JONG_"):
        JONG_I[tok[5:]] = _t
        _t += 1


def compose(tokens):
    out, cur = [], [None, None, None]

    def flush():
        nonlocal cur
        if cur == [None, None, None]:
            return
        ch, ju, jo = cur
        if ch is not None and ju is not None and ch in CHO_I and ju in JUNG_I:
            ti = JONG_I.get(jo, 0) if jo else 0
            out.append(chr(0xAC00 + (CHO_I[ch] * 21 + JUNG_I[ju]) * 28 + ti))
        else:
            for v in cur:
                if v:
                    out.append(v)
        cur = [None, None, None]

    for tok in tokens:
        if tok.startswith("CHO_"):
            v = tok[4:]
            if cur == [None, None, None]:
                cur[0] = v
            else:
                flush()
                cur = [v, None, None]
        elif tok.startswith("JUNG_"):
            v = tok[5:]
            if cur[0] is not None and cur[1] is None:
                cur[1] = v
            else:
                flush()
                cur = [None, v, None]
        elif tok.startswith("JONG_"):
            v = tok[5:]
            if cur[0] is not None and cur[1] is not None and cur[2] is None:
                cur[2] = v
                flush()
            else:
                flush()
                out.append(v)
        elif tok.startswith("<"):
            pass
        else:
            flush()
            out.append(tok)
    flush()
    return unicodedata.normalize("NFC", "".join(out))


OSESS = ort.InferenceSession("public/models/crnn.onnx")
GSESS = ort.InferenceSession("public/models/gate_v1.onnx")
DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)


def ocr(img_rgb):
    h = 32
    w = min(512, max(8, round(h * img_rgb.shape[1] / img_rgb.shape[0])))
    sc = cv2.resize(img_rgb, (w, h), interpolation=cv2.INTER_LINEAR)
    g = (0.299 * sc[:, :, 0] + 0.587 * sc[:, :, 1] + 0.114 * sc[:, :, 2]) / 255.0
    padded = ((w + 3) // 4) * 4
    data = np.full((h, padded), -1.0, np.float32)
    data[:, :w] = (g - 0.5) / 0.5
    out = OSESS.run(None, {"images": data[None, None], "image_widths": np.array([padded], np.int64)})[0][0]
    ids = out.argmax(1)
    toks, prev = [], -1
    for i in ids:
        if i != BLANK and i != prev:
            toks.append(VOCAB[i])
        prev = int(i)
    return compose(toks)


def gate(img_rgb):
    x = cv2.resize(img_rgb, (320, 96)).astype(np.float32) / 255
    mean = np.array([0.485, 0.456, 0.406])
    std = np.array([0.229, 0.224, 0.225])
    x = ((x - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    p = 1 / (1 + np.exp(-GSESS.run(None, {GSESS.get_inputs()[0].name: x})[0][0]))
    return int((p > 0.5).sum()), float(1 - p[2])


def judge(path, template_json, slot_idx):
    t = json.load(open(template_json, encoding="utf-8"))
    img = cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)
    scale = min(1, 2400 / max(img.shape[:2]))
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale)
    corners, ids, _ = cv2.aruco.ArucoDetector(DICT).detectMarkers(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY))
    if ids is None:
        return None
    byid = {i: c[0] for i, c in zip(ids.flatten().tolist(), corners)}
    src, dst = [], []
    for m in t["corner_markers"]:
        if m["aruco_id"] not in byid:
            return None
        src.append([m["top_left_mm"][0] + m["size_mm"][0] / 2, m["top_left_mm"][1] + m["size_mm"][1] / 2])
        dst.append(byid[m["aruco_id"]].mean(axis=0))
    Hm = cv2.getPerspectiveTransform(np.float32(src), np.float32(dst))
    s = t["note_slots"][slot_idx]["rect_mm"]
    l, tp = s[0] + s[2] * 0.08, s[1] + s[3] * 0.18
    r, b = s[0] + s[2] * 0.98, s[1] + s[3] * 0.92
    ppm = min(14, max(5, img.shape[1] / t["page"]["size_mm"][0]))
    outW, outH = round((r - l) * ppm), round((b - tp) * ppm)
    quad = cv2.perspectiveTransform(np.float32([[[l, tp]], [[r, tp]], [[r, b]], [[l, b]]]), Hm).reshape(4, 2)
    M2 = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [outW, 0], [outW, outH], [0, outH]]))
    crop = cv2.warpPerspective(img, M2, (outW, outH))
    g, sc_ = gate(crop)
    return {"ocr": ocr(crop), "grade": g, "score": round(sc_, 3), "crop": f"{outW}x{outH}"}


def strip_spaces(s):
    return s.replace(" ", "").replace("　", "")


if __name__ == "__main__":
    if sys.argv[1] == "--all":
        words = {0: ["나무", "오리", "나비", "바나나"], 1: ["사과", "구름", "연필", "눈사람"], 2: ["딸기", "토끼", "돼지", "무지개"]}
        ok = 0
        for t, ws in words.items():
            for si, w in enumerate(ws):
                r = judge(f"public/dev/w_t{t}s{si}.png", f"public/worksheets/DICT_0{t+1}_v1.json", si)
                match = r and strip_spaces(r["ocr"]) == w
                ok += bool(match)
                print(f"t{t}s{si} {w}: {r} {'OK' if match else 'MISS'}")
        print(f"{ok}/12")
    else:
        path, word = sys.argv[1], sys.argv[2]
        slot = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        tj = "public/worksheets/DICT_01_v1.json"
        print(judge(path, tj, slot), "target", word)
