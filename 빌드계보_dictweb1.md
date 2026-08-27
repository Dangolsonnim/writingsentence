# 빌드 계보 — 받아쓰기 웹앱 `dictweb1`

*작성 2026-08-27. 지시문: `배포2_준비/받아쓰기_지시문_개발.md` (체크리스트 §8-10).*

## 0. 웹판 v2 흐름 변경 (사용자 확정 2026-08-27 — 지시문 §2 대체)

- 학생이 학습지 4칸을 **모두 쓴 뒤 전체를 1회 촬영** → 4칸 일괄 판정. (문항별 촬영 폐지)
- **판정 모드 margin (기본, 2026-08-28 사용자 확정 — 게이트를 판정에서 제외)**:
  실기기 진단에서 게이트 v1이 받아쓰기 도메인(짧은 낱말·작은/연한 글씨)에서 정자도 0등급
  거부하는 일반화 한계가 확인되어, 명료성 판정을 **AI 읽기 신뢰도**로 대체.
  통과 = 방출 토큰 신뢰도 conf ≥ λ(기본 0.35) AND 강제 정렬 여유도 M ≤ τ1.
  conf < λ → illegible("글자를 읽기 어려워요…" — 낙서 차단, M은 상대 여유도라 낙서에서
  무력함을 실측으로 확인해 절대 신뢰도 병용). 읽히지만 M > τ2 → 1-자모 이웃 M_best ≤ τ1이면
  철자 위치 문구, 아니면 '처음부터' 강등 문구. 연출 등급 = M 밴드(≤0.03→5/≤0.10→4/그 외 3).
  탈출구는 illegible 누적 3회에 적용. **게이트는 전 칸 추론·로깅 유지**(지시문 §6, 재보정
  재료)하되 판정 미사용. 기존 게이트 판정은 `judge_mode='gate'` 설정으로 복원 가능(연구 비교).
  실측 검증: 사용자 실기기 정자 12크롭 전부 통과(lv5), 낙서 실물 5+합성 1 전부 illegible
  (conf ≤0.26 vs 정상 ≥0.48), 성인 정자 골든 36 전부 통과 유지.
- (gate 모드 시) **통과 = 게이트(명료성) 통과 AND 철자 검증 '정답'.** 철자는 자유 전사 문자열 비교가
  아니라 **검증(verification) 모드**(지시문 §3, 2026-08-27 도메인 평가로 확정): CTC 강제
  정렬 여유도 M ≤ τ1(기본 0.25) 정답 / τ1<M≤τ2(기본 0.45) 판정 유보("한 번만 더 또박또박
  써서 찍어 볼까요?", 탈출구 카운트 미차감) / M > τ2 오답 확정 → 1-자모 이웃 강제 정렬로
  추정 낱말 특정 → **대조기(골든 76/76 계약 유지)가 차이 문구 생성**. τ1·τ2는 설정값,
  전 판정 칸에 M 연속값·판정·임계 로깅(`verify_margin`/`verify_decision`/`verify_tau1·2`/
  `estimated_written`). (개방 전사 비교는 EM 47.2%라 채택 불가 — 도메인평가_결과.md)
- 그림 단서는 차시 시작 시 4개를 한 번 보여준다.
- **라이브 카메라 AR**: 실시간 ArUco 추적(다운스케일 프레임 ~7fps) 위에 통과 낱말
  3D 사물(등급 3/4/5 연출 동일 적용) + "멋진 글자예요!" 말풍선, 미달 낱말은
  안내 말풍선만(게이트 미달 "좀 더 바르게 써볼까요?" / 유보 / 오답 자모 위치 문구).
  **AR 사물은 학습지의 그림 단서 이미지(cue_rect_mm) 위에 앵커링**(말풍선은 사물 옆),
  안내 말풍선은 글씨 칸 위 — 사용자 확정 2026-08-27. 판정은 캡처 1회(하이브리드).
  카메라 불가 시 정지 사진 오버레이 폴백(`getUserMedia` 실패 자동 감지).
- 통과 낱말은 재촬영에도 통과 유지(게이트·공백 지표는 계속 기록, `gate_decision=override`).
- 탈출구: 같은 word_id REJECT 누적 3회 → 다음 촬영부터 override 통과("열심히 썼네요!").
- 로그: 촬영 1회당 4칸 각각 note_attempt 행 기록(`retry_index` = 촬영 회차).

## 1. 스택·의존성 버전

| 층 | 패키지 | 버전 |
|---|---|---|
| 빌드 | vite | 5.4.21 |
| 언어 | typescript | 5.9.3 |
| PWA | vite-plugin-pwa (workbox generateSW) | 0.20.5 |
| 추론 | onnxruntime-web (WASM, SIMD, 단일 스레드 — COOP/COEP 불요) | 1.29.0 |
| 비전 | @techstark/opencv-js (`aruco_ArucoDetector`, DICT_4X4_50) | 4.10.0-release.1 |
| 3D | three | 0.169.0 |
| 압축 | fflate (세션 패키지 zip) | 0.8.3 |
| 테스트 | vitest 2.1.9 · onnxruntime-node 1.29.0 · pngjs 7.0.0 | |
| 도구 | Node v24.16.0 · Python 3.11.9 (cv2 4.10.0, reportlab 5.0.0, onnxruntime 1.20.1) | |

## 2. 모델·자산 계보

| 자산 | 출처 | 비고 |
|---|---|---|
| `public/models/gate_v1.onnx` (6.4MB) | `배포2_게이트/gate_v1.onnx` | 게이트 v1 (CORN 5로짓), 버전 문자열 `v1` |
| `public/models/crnn.onnx` (32.4MB) | 로봇 앱 `assets/models/ocr/crnn.onnx` | jamo_no_null, 620클래스. 경로 고정 — 교체 통지 시 파일만 교체 |
| `public/models/tokenizer.json` | 로봇 앱 동일 파일 | 문자표 620 그대로 |
| `public/worksheets/DICT_0N_v1.json` + `marker_map_dict.json` | `scripts/gen_templates.mjs` 생성(단일 소스) | ArUco id 38~49 (로봇 1~15·31~37과 비겹침), 35mm, innerRatio 0.88 |

앱 버전 문자열: **`dictweb1`** (`src/logging/logger.ts APP_VERSION`, 전 로그 기록).
프리캐시: 18항목 63.8MB (앱 셸 + 모델 2종 + tokenizer + 학습지 JSON + ORT WASM; OpenCV.js는 번들 내).

## 3. 동작 동등 이식 대응표

| 웹 모듈 | 원본(로봇 앱, 읽기 전용 참조) | 동등성 확인 |
|---|---|---|
| `src/core/jamo.ts` | `받아쓰기_정답대조기/jamo_matcher.py` | 골든 76/76 (아래 §4-1) |
| `src/core/ocr.ts`·`hangul.ts` | `core/ocr/OnnxOcrEngine.kt`·`CrnnTokenizer.kt`·`HangulComposer.kt` | 전처리 수식·CTC·조합 동일 코드 경로, OCR 동등성 §4-2 |
| `src/core/gate.ts` | `core/gate/GateClassifier.kt` | 96×320 스트레치·ImageNet 정규화·등급/점수 산식 동일, 스모크 §4-3 |
| `src/core/blank.ts` | `logging/SlotInkAnalyzer.kt` | 파라미터(145, mean−22, 0.82/0.35, 면적≥4) 동일 |
| `src/core/vision.ts` | `logging/MarkerAlignedSlotCropper.kt` | 마커 중심 4점 호모그래피, 크롭 프로파일 인셋·pixelsPerMm(5..14)·최소 크기 동일. 검출만 커스텀 검출기 → OpenCV.js ArUco로 대체(지시문 §0 지정) |
| `src/core/verify.ts` | `도메인평가/eval_domain.py` 전처리 + 지시문 §3 검증 모드 수식 | 골든 36크롭 × 12낱말 M 재현 432셀 **최대 오차 0.0000**(±0.01 계약), τ1=0.25에서 정답 인정 36/36·오답 오인정 1.0% — 결과 문서 §2 운영점과 일치 |
| `src/logging/*` | `logging/ResearchEntities.kt`·`SessionPackageExporter.kt`·`SlotCropSaver.kt` | 필드명·패키지 구조(manifest/export/events.jsonl/images/) 동일 + 신설 필드 |
| 업로드 | `logging/SupabaseUploadWorker.kt` | POST zip + `x-classroom-upload-token`/`x-session-package-name` 동일 |

## 4. 자체 검증 체크리스트 결과 (지시문 §8)

0. **철자 검증 모드 동등성 골든(신설, 지시문 §3)** — ✅ `tests/verify.golden.test.ts`:
   도메인평가 실손글씨 36크롭 × 12낱말 여유도 M 재현 432셀 **최대 오차 0.0000**(계약 ±0.01),
   τ1=0.25에서 정답 인정 36/36·오답 오인정 4/396(1.0%) — 결과 문서의 운영점 그대로 재현.
   **실측 한계 기록**: 또박또박 쓴 1-자모 오답(폰트 '나모' vs '나무')의 M=0.212가
   τ1=0.25 아래로 들어와 통과됨 — 도메인평가_결과.md §4가 예고한 한계로, 전 칸 M 로깅이
   파일럿 재보정 재료. E2E는 설정 임계로 유보/오답 분기를 강제해 검증(이웃 탐색이
   추정 낱말 '나모'와 "중성 'ㅜ'…'ㅗ'라고 쓰여 있어요" 문구를 정확히 산출).
1. **정답 대조기 골든 76/76** — ✅ `tests/jamo.golden.test.ts` PASS (5필드 전부 일치).
   (검증 모드에서 대조기 역할 = 추정 낱말 vs 정답의 차이 문구 생성 — 계약 동일)
2. **OCR 동등성 20장** — ⚠ **13/20** (`tests/ocr.parity.test.ts`). **원인(불일치 보고)**:
   골든 `crops/*.png`는 배포1 연구 로그의 **저장용 Full 프로파일 크롭**(칸 87×25mm, 인쇄
   테두리·"명령 N" 라벨 포함)이고, CSV의 기기 OCR 원문은 **OcrWide 프로파일 크롭**(사진에서
   직접 워핑)의 인식 결과다. 즉 골든 이미지는 기기 OCR 입력 픽셀이 아니다. 러너는 동일 워프
   격자의 소수 픽셀 오프셋 관계로 OcrWide 입력을 재구성(catmull-rom)해 13/20 일치를 얻었고,
   ±1~2px 지터에 3~8건이 뒤집히는 민감도를 확인(이중 리샘플 고유 손실). 불일치 7건은 전부
   공백 토큰 1개 또는 자모 1개 차이이며, 일치 건의 신뢰도 차 |Δconf| ≤ 0.06으로 엔진 동등성은
   확인됨. **≥18/20 판정은 연구 측이 기기 OCR 입력(OcrWide) 크롭 원본을 제공하면 재실행.**
3. **게이트 스모크** — ✅ 정자 5장 평균 등급 4.2(3~5) vs 낙서 5장 평균 0.0, 서열 겹침 없음
   (`tests/gate.smoke.test.ts`, 표본: 평정확대_v1 600장 중 gate_score 양극단 5+5).
4. **판정 분기 시연** — ✅ `npm run test:e2e`(`tests/e2e_pipeline.node.ts`; vitest 워커에서
   opencv.js WASM이 크래시해 순수 Node 러너로 분리) + 브라우저 시연.
   **v2 분기 기준**: 명료성 미달(낙서·인쇄체 → REJECT, "좀 더 바르게 써볼까요?" 말풍선,
   OCR 생략) / 공백("여기에 낱말을 써 보세요") / 통과(실물 손글씨 크롭 grade 5 →
   "멋진 글자예요!" + AR 사물) / 통과 유지(재촬영 미달이어도 pass 유지) / 전체 시트 4칸
   일괄 판정 / 철자 대조는 로그로만 산출(철자 오답이어도 pass 확인). **참고**: 게이트 v1은
   실제 연필 손글씨 캡처 도메인에 특화되어 합성 인쇄체를 0등급 거부(실물 크롭은 동일
   파이프라인에서 4~5등급) — 연출 3/4/5 차등·라이브 AR 추적의 실기기 확인은 §8-9에서
   실제 손글씨로 수행할 것.
5. **탈출구** — ✅ 같은 word_id REJECT 3회 → 4회째 `gate_decision="override"` 통과 +
   "열심히 썼네요!" 문구 (Node E2E + 브라우저 E2E에서 확인, `escape_used` 로깅).
6. **class_group A/B** — ✅ A→임계 4, B→임계 3 적용, 세션·시도 로그에
   `class_group`/`gate_pass_threshold` 기록 확인.
7. **12낱말 E2E** — ✅ 브라우저에서 3차시 × 4낱말 전부 통과(합성 사진, 모아 보기 포함,
   각 낱말 12/12 OCR 정확 판독 사전 확인). 업로드 패키지 3개 생성: manifest.json +
   export.json + events.jsonl + images/slot_crop_*.png(시도별 크롭 전부), 신설 필드 54종 확인
   (content_type/template_id/word_id/target_word/gate_grade/gate_score/gate_pass_threshold/
   gate_decision/class_group/jamo_edit_distance/wrong_jamo_positions/spelling_correct/
   reward_level/retry_index/escape_used/gate_model_version/app_version 포함).
   통과·거부 무관 전 시도에 gate_grade·gate_score 기록 확인(16시도/세션).
8. **오프라인** — ◐ SW 프리캐시 목록에 앱 셸+crnn+gate+tokenizer+학습지 JSON+ORT WASM
   전부 포함 확인(18항목 63.8MB). 개발 환경 내장 브라우저가 ServiceWorker 등록을 차단해
   비행기 모드 실동작은 실기기(§8-9)에서 확인 필요. 추론은 전부 로컬이므로 판정 자체는
   네트워크 불요(개발 서버만으로 촬영→판정→연출 전 과정 동작 확인).
9. **Android 실기기** — ☐ 미수행(개발 환경에 실기기 없음). 태블릿 Chrome에서 촬영 화질,
   칸당 OCR 지연 확인 필요. 데스크톱 Chrome(WASM) 실측: ArUco+워핑+공백 0.4~0.9s,
   게이트 ~0.15s, OCR 0.3~0.7s — **칸당 합계 ≈ 1.3~2.5s** (기준 3s 이내; 태블릿에서는
   2~3배 여유를 두고 재실측 권장).
10. **빌드 계보** — ✅ 본 문서.

## 5. 알려진 설계 확정·주의

- **음절 쓰기 보조 칸(2026-08-27 사용자 확정)**: 각 쓰기 칸에 22×22mm 정사각 4개
  (낱말 길이 무관 고정 — 음절 수 힌트 방지) + 연한 점선 십자(2×2). 실기기 진단에서
  확인된 '칸 대비 작은 글씨 → 게이트 0등급' 문제에 대한 학습지 측 대응(큰 글씨 유도).
  선 톤(외곽 #d4d4d4 / 십자 #e0e0e0)은 실물 손글씨 크롭 합성 실험으로 무해성 검증:
  게이트 점수·공백 감지·검증 M(4낱말 모두 0.000) 무영향. 좌표는 템플릿 JSON
  `guide_cells_mm` 단일 소스(인쇄 페이지·PDF·합성 사진 공용).
- **칸 기하 = 로봇 칸 정비례 1.4배(115×28mm)**: 개발 중 실측으로, 크롭 종횡비가 학습 도메인
  (로봇 82×20)에서 벗어나 빈 꼬리가 길어지면 낱말끝 받침 인식이 체계적으로 탈락함을 확인.
  칸 폭을 늘릴 경우 반드시 정비례 유지.
- 게이트 v1은 캡처 텍스처(종이 질감·조명·연필 톤)에 민감 — 인쇄체·스캔 원고는 거부된다.
  이는 결함이 아니라 학습 도메인 특성이며, 파일럿 전 실기기·실손글씨 스모크(§8-9)로 재확인.
- 교사 설정 PIN 기본값 `7391` (`src/app.ts DEFAULT_PIN`) — 배포 전 변경 권장.
- 업로드 토큰 미설정 시 패키지는 IndexedDB 큐에 보존만 되고 전송하지 않는다.
