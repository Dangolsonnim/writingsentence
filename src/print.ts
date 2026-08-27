/**
 * 학습지 인쇄 페이지 (#print) — 템플릿 JSON(단일 소스)에서 A4 3장 렌더.
 * 마커 = DICT_4X4_50 SVG, 그림 단서 = three.js 렌더 정지컷(화면용과 동일 씬).
 * 정답 낱말 텍스트는 인쇄하지 않는다 (지시문 §5).
 */
import { arucoMarkerSvg } from './core/aruco_dict';
import { loadAllTemplates, type DictTemplate } from './core/worksheet';
import { cueStill } from './three/stage';
import { zipSync } from 'fflate';

export async function renderPrintPage(root: HTMLElement): Promise<void> {
  const templates = await loadAllTemplates(import.meta.env.BASE_URL);
  root.innerHTML = `
    <div class="no-print card" style="margin-bottom:12px">
      <b>학습지 인쇄</b> — 브라우저 인쇄(Ctrl+P)에서 여백 '없음', 배율 100%로 인쇄하세요.
      마커 크기(35mm)가 정확해야 인식됩니다.
      <div style="margin-top:10px; display:flex; gap:8px">
        <button class="big-btn" id="btn-print" style="width:auto;padding:10px 18px;font-size:1rem">인쇄</button>
        <button class="big-btn ghost" id="btn-cues" style="width:auto;padding:10px 18px;font-size:1rem">단서 PNG 내려받기(zip)</button>
        <a class="big-btn ghost" href="#" onclick="location.hash='';return false" style="width:auto;padding:10px 18px;font-size:1rem">앱으로</a>
      </div>
    </div>
    <div id="sheets"></div>`;
  const sheets = root.querySelector('#sheets')!;
  for (const t of templates) sheets.appendChild(renderSheet(t));

  root.querySelector('#btn-print')!.addEventListener('click', () => window.print());
  root.querySelector('#btn-cues')!.addEventListener('click', () => downloadCueZip(templates));
}

function renderSheet(t: DictTemplate): HTMLElement {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const title = document.createElement('h2');
  title.textContent = t.title;
  sheet.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'meta-line';
  meta.textContent = '학급 ______   이름 ______________';
  sheet.appendChild(meta);

  for (const m of t.corner_markers) {
    const div = document.createElement('div');
    div.className = 'abs';
    div.style.left = `${m.top_left_mm[0]}mm`;
    div.style.top = `${m.top_left_mm[1]}mm`;
    div.style.width = `${m.size_mm[0]}mm`;
    div.style.height = `${m.size_mm[1]}mm`;
    div.innerHTML = arucoMarkerSvg(m.aruco_id, m.size_mm[0]);
    sheet.appendChild(div);
  }

  for (const s of t.note_slots) {
    const [x, y, w, h] = s.rect_mm;
    const box = document.createElement('div');
    box.className = 'slot-box';
    box.style.left = `${x}mm`;
    box.style.top = `${y}mm`;
    box.style.width = `${w}mm`;
    box.style.height = `${h}mm`;
    sheet.appendChild(box);
    const label = document.createElement('div');
    label.className = 'slot-label';
    label.style.left = `${x + 1.5}mm`;
    label.style.top = `${y + 1}mm`;
    label.textContent = s.label;
    sheet.appendChild(label);
    // 음절 쓰기 보조 칸: 연한 외곽 + 점선 십자(2×2) — 큰 글씨·바른 짜임 유도
    const g = t.writing_guide;
    for (const [gx, gy, gw, gh] of s.guide_cells_mm) {
      const cell = document.createElement('div');
      cell.className = 'guide-cell';
      cell.style.left = `${gx}mm`;
      cell.style.top = `${gy}mm`;
      cell.style.width = `${gw}mm`;
      cell.style.height = `${gh}mm`;
      cell.style.border = `${g.line_mm}mm solid ${g.outline_color}`;
      const vLine = document.createElement('div');
      vLine.className = 'guide-cross-v';
      vLine.style.borderLeft = `${g.line_mm}mm dashed ${g.cross_color}`;
      const hLine = document.createElement('div');
      hLine.className = 'guide-cross-h';
      hLine.style.borderTop = `${g.line_mm}mm dashed ${g.cross_color}`;
      cell.append(vLine, hLine);
      sheet.appendChild(cell);
    }

    const [cx, cy, cw, ch] = s.cue_rect_mm;
    const cue = document.createElement('div');
    cue.className = 'cue-box';
    cue.style.left = `${cx}mm`;
    cue.style.top = `${cy}mm`;
    cue.style.width = `${cw}mm`;
    cue.style.height = `${ch}mm`;
    const img = document.createElement('img');
    img.src = cueStill(s.scene_key);
    img.alt = '';
    cue.appendChild(img);
    sheet.appendChild(cue);
  }
  return sheet;
}

async function downloadCueZip(templates: DictTemplate[]): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  for (const t of templates) {
    for (const s of t.note_slots) {
      const dataUrl = cueStill(s.scene_key);
      const b64 = dataUrl.split(',')[1];
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      files[`${s.scene_key}.png`] = buf;
    }
  }
  const zipped = zipSync(files);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dictweb_cues.zip';
  a.click();
  URL.revokeObjectURL(a.href);
}
