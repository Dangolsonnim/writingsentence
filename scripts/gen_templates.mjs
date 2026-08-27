// 받아쓰기 학습지 템플릿(DICT_01~03) + marker_map 확장 생성 — 단일 소스.
// 실행: node scripts/gen_templates.mjs
// 마커 좌표는 여기서만 정의되고, 앱(크롭)과 PDF 스크립트가 같은 JSON을 읽는다.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A4 세로 210x297. ArUco DICT_4X4_50 4점(35mm, innerRatio 0.88 — 로봇 학습지와 동일 규격).
// 로봇 앱 마커 ID(1~15, 31~37)와 겹치지 않도록 38~49 사용.
const PAGE = [210, 297];
const MARKER_SIZE = 35;
const MARGIN = 10;
const CORNERS = [
  { anchor: 'TL', topLeft: [MARGIN, MARGIN] },
  { anchor: 'TR', topLeft: [PAGE[0] - MARGIN - MARKER_SIZE, MARGIN] },
  { anchor: 'BR', topLeft: [PAGE[0] - MARGIN - MARKER_SIZE, PAGE[1] - MARGIN - MARKER_SIZE] },
  { anchor: 'BL', topLeft: [MARGIN, PAGE[1] - MARGIN - MARKER_SIZE] },
];

// 칸 = 로봇 학습지 칸(82×20mm)의 정비례 1.4배(115×28mm) — 세로 1.3~1.5배(지시문 §5) 충족.
// 정비례 유지 이유: OCR 크롭 종횡비를 학습 도메인(로봇 칸)과 일치시켜
// 넓은 빈 꼬리로 인한 낱말끝 받침 인식 탈락을 방지(개발 중 실측 확인).
const SLOT_H = 28;
const SLOT_RECTS = [58, 106, 154, 202].map((y) => [56, y, 115, SLOT_H]);
const CUE_RECTS = [58, 106, 154, 202].map((y) => [16, y - 2, 32, 32]);

const SETS = [
  { n: 1, ids: [38, 39, 40, 41], words: ['나무', '오리', '나비', '바나나'], focus: '무받침' },
  { n: 2, ids: [42, 43, 44, 45], words: ['사과', '구름', '연필', '눈사람'], focus: '받침·복모음(ㅘ)' },
  { n: 3, ids: [46, 47, 48, 49], words: ['딸기', '토끼', '돼지', '무지개'], focus: '된소리(ㄸ·ㄲ)·복모음(ㅙ·ㅐ)' },
];

// three.js 씬 키(연출·그림 단서 렌더와 1:1)
const SCENE_KEYS = {
  나무: 'tree', 오리: 'duck', 나비: 'butterfly', 바나나: 'banana',
  사과: 'apple', 구름: 'cloud', 연필: 'pencil', 눈사람: 'snowman',
  딸기: 'strawberry', 토끼: 'rabbit', 돼지: 'pig', 무지개: 'rainbow',
};

const markerMap = {
  dictionary: 'DICT_4X4_50',
  physicalSizeMm: MARKER_SIZE,
  markers: [],
};

mkdirSync(join(root, 'public', 'worksheets'), { recursive: true });

for (const set of SETS) {
  const tid = `DICT_0${set.n}_v1`;
  const pid = `DICT_0${set.n}`;
  const cornerMarkers = CORNERS.map((c, i) => ({
    aruco_id: set.ids[i],
    name: `${pid}_${c.anchor}_MARKER`,
    anchor: c.anchor,
    top_left_mm: c.topLeft,
    size_mm: [MARKER_SIZE, MARKER_SIZE],
    inner_ratio: 0.88,
    purpose: 'page_homography',
  }));
  for (const m of cornerMarkers) {
    markerMap.markers.push({
      arucoId: m.aruco_id,
      markerName: m.name,
      templateId: tid,
      problemId: pid,
      anchor: m.anchor,
      dictionary: 'DICT_4X4_50',
      physicalSizeMm: MARKER_SIZE,
      innerRatio: 0.88,
      centerMm: [m.top_left_mm[0] + MARKER_SIZE / 2, m.top_left_mm[1] + MARKER_SIZE / 2],
    });
  }
  const template = {
    template_id: tid,
    template_version: '1.0.0',
    problem_id: pid,
    content_type: 'dictation',
    title: `받아쓰기 ${set.n}차시`,
    difficulty_focus: set.focus,
    page: { size_mm: PAGE, orientation: 'portrait', origin: 'top_left', coordinate_unit: 'mm' },
    slot_height_scale_vs_robot: SLOT_H / 20,
    corner_markers: cornerMarkers,
    note_slots: set.words.map((w, i) => ({
      slot_id: i + 1,
      order: i + 1,
      word_id: `D${set.n}W${i + 1}`,
      target_word: w,
      scene_key: SCENE_KEYS[w],
      rect_mm: SLOT_RECTS[i],
      cue_rect_mm: CUE_RECTS[i],
      label: `${i + 1}`,
    })),
  };
  writeFileSync(
    join(root, 'public', 'worksheets', `${tid}.json`),
    JSON.stringify(template, null, 2),
    'utf-8'
  );
}

writeFileSync(
  join(root, 'public', 'worksheets', 'marker_map_dict.json'),
  JSON.stringify(markerMap, null, 2),
  'utf-8'
);
console.log('generated DICT_01~03_v1.json + marker_map_dict.json');
