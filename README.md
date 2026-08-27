# 받아쓰기 웹앱 (dictweb1)

초등 1~2학년 받아쓰기 학습 웹앱. **웹판 v2 흐름(사용자 확정 2026-08-27)**:
그림 단서 4개를 먼저 보여준 뒤, 학생이 종이 학습지의 **4칸을 모두** 연필로 쓰고
**학습지 전체를 1회 촬영**하면 브라우저 내(WASM)에서 4칸을 일괄 판정한다.
통과 기준은 **글씨 명료성(게이트 v1)만** — 철자(자모 대조)는 OCR 오인식 위험 때문에
판정에서 제외하고 연구 로그로만 기록한다. 통과한 낱말은 **라이브 카메라 AR** 위에
3D 사물(등급 3/4/5 연출)과 "멋진 글자예요!" 말풍선으로 실체화되고, 미달 낱말에는
"좀 더 바르게 써볼까요?" 말풍선만 띄운다. 통과 상태는 재촬영에도 유지(누적)된다.
카메라를 쓸 수 없으면 정지 사진 오버레이로 폴백. 로봇 앱(OcrArRobotAndroid)과
별개의 독립 정적 PWA. 근거 지시문: `배포2_준비/받아쓰기_지시문_개발.md`(활동 흐름 §2는
위 v2 결정으로 대체).

## 실행

```bash
npm install
npm run dev        # 개발 서버
npm run build      # dist/ 정적 빌드 (PWA 프리캐시 포함, 약 64MB)
npm run preview    # 빌드 미리보기
npm test           # 골든 76 + OCR 동등성 + 게이트 스모크 + 판정 분기 E2E
```

배포: `dist/`를 정적 호스팅(Cloudflare Pages 등)에 업로드. URL 고정, 버전 `dictweb1`.
단일 스레드 WASM(SIMD)이므로 COOP/COEP 헤더 불요.

## 구조

| 경로 | 내용 |
|---|---|
| `src/core/jamo.ts` | 정답 대조기 (jamo_matcher.py 포팅 — 골든 76/76) |
| `src/core/ocr.ts` `hangul.ts` | CRNN 전처리·CTC 그리디·자모 조합 (OnnxOcrEngine.kt 동등) |
| `src/core/gate.ts` | 게이트 v1 (GateClassifier.kt 동등: 96×320 스트레치, 등급=sigmoid>0.5 개수) |
| `src/core/blank.ts` | 공백 감지 잉크 비율 (SlotInkAnalyzer.kt 동등) |
| `src/core/vision.ts` | OpenCV.js ArUco DICT_4X4_50 검출 + 호모그래피 칸 크롭 |
| `src/core/pipeline.ts` | 시트 일괄 판정(`judgeSheet`) + 라이브 추적(`trackSheet`) — 통과=게이트만, OCR·대조는 로그용 |
| `src/ui/live_ar.ts` | 라이브 카메라 AR — 실시간 마커 추적(~7fps) 위 3D 사물·말풍선 앵커링, 정지 사진 폴백 |
| `src/three/scenes.ts` | 12낱말 프리미티브 조합 씬 + 고유 동작 루프 |
| `src/three/stage.ts` | 그림 단서 정지컷 / 모아 보기 / 효과음 |
| `src/logging/` | IndexedDB 연구 로그, 세션 패키지(zip), 업로드 재시도 큐 |
| `src/print.ts` | `#print` 학습지 인쇄 페이지 (템플릿 JSON 단일 소스) |
| `public/worksheets/` | DICT_01~03 템플릿 + marker_map 확장 (`scripts/gen_templates.mjs` 생성) |
| `public/models/` | `crnn.onnx`(32MB) · `gate_v1.onnx`(6.4MB) · `tokenizer.json` |
| `scripts/make_worksheets.py` | 학습지 PDF 생성 (reportlab + cv2.aruco, 단서=`scripts/cues/`) |
| `scripts/make_synthetic_photo.py` | 판정 분기 시연용 합성 학습지 사진 생성 |

## 운영 메모

- **교사 설정**: 시작 화면 우상단 ⚙️ → PIN(기본 `7391`, 코드 상수 `DEFAULT_PIN`) →
  class_group A(임계4)/B(임계3), 업로드 URL·토큰, 패키지 큐. 차시 진행 중 변경 불가.
- **업로드**: `POST {supabase}/functions/v1/classroom-upload`,
  헤더 `x-classroom-upload-token`/`x-session-package-name` (로봇 앱과 동일 프로토콜).
  토큰은 연구 측이 설정. 미설정 시 큐에 보존만 된다.
- **학습지 인쇄**: 설정 → 학습지 인쇄(`#print`) 또는 `scripts/make_worksheets.py` PDF.
  여백 없음·배율 100%로 인쇄해야 마커 35mm가 유지된다.
- **OCR 모델 교체**: `public/models/crnn.onnx` 파일 교체(경로 고정). 도메인 평가 결과에 따라
  연구 측 통지 시 교체.
- **칸 기하**: 로봇 칸(82×20mm)의 정비례 1.4배(115×28mm). 정비례를 깨고 더 넓히면
  OCR 크롭 빈 꼬리가 길어져 낱말끝 받침 인식이 탈락하는 것을 실측으로 확인(변경 금지).

## 검증

`npm test` + 검증 상세는 [빌드계보_dictweb1.md](빌드계보_dictweb1.md) 참고.
