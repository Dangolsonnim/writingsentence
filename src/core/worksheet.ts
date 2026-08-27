/** 받아쓰기 학습지 템플릿 로딩 (public/worksheets/DICT_0N_v1.json — gen_templates.mjs 단일 소스) */

export interface CornerMarker {
  aruco_id: number;
  name: string;
  anchor: 'TL' | 'TR' | 'BR' | 'BL';
  top_left_mm: [number, number];
  size_mm: [number, number];
  inner_ratio: number;
  purpose: string;
}

export interface DictSlot {
  slot_id: number;
  order: number;
  word_id: string;
  target_word: string;
  scene_key: string;
  rect_mm: [number, number, number, number];
  cue_rect_mm: [number, number, number, number];
  label: string;
}

export interface DictTemplate {
  template_id: string;
  template_version: string;
  problem_id: string;
  content_type: 'dictation';
  title: string;
  difficulty_focus: string;
  page: { size_mm: [number, number]; orientation: string; origin: string; coordinate_unit: string };
  slot_height_scale_vs_robot: number;
  corner_markers: CornerMarker[];
  note_slots: DictSlot[];
}

export const TEMPLATE_IDS = ['DICT_01_v1', 'DICT_02_v1', 'DICT_03_v1'] as const;

const cache = new Map<string, DictTemplate>();

export async function loadTemplate(templateId: string, baseUrl = ''): Promise<DictTemplate> {
  const hit = cache.get(templateId);
  if (hit) return hit;
  const res = await fetch(`${baseUrl}worksheets/${templateId}.json`);
  if (!res.ok) throw new Error(`template load failed: ${templateId} (${res.status})`);
  const t = (await res.json()) as DictTemplate;
  cache.set(templateId, t);
  return t;
}

export async function loadAllTemplates(baseUrl = ''): Promise<DictTemplate[]> {
  return Promise.all(TEMPLATE_IDS.map((id) => loadTemplate(id, baseUrl)));
}

/** aruco id → template id (모든 템플릿의 코너 마커에서) */
export function templateIdForArucoId(templates: DictTemplate[], arucoId: number): string | null {
  for (const t of templates) {
    if (t.corner_markers.some((m) => m.aruco_id === arucoId)) return t.template_id;
  }
  return null;
}
