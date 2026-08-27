/**
 * 받아쓰기 정답 대조기 — TypeScript 포팅.
 * 참조 구현: 배포2_준비/받아쓰기_정답대조기/jamo_matcher.py (골든 스펙).
 * 포팅 계약(README §포팅 계약): NFC·공백 제거, 초19/중21/종27(복합 단일 토큰),
 * 자모 Levenshtein, 역추적 동순위 누락→치환→추가, distance≥3 또는 길이차≥3 강등.
 */

const CHO = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const JUNG = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
const JONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];

export type JamoErrorType = 'missing' | 'wrong' | 'extra';

export interface JamoError {
  type: JamoErrorType;
  syllable_index: number;
  syllable: string;
  role: string;
  expected: string | null;
  written: string | null;
}

export interface CompareResult {
  distance: number;
  correct: boolean;
  errors: JamoError[];
  message: string;
}

interface JamoItem {
  jamo: string;
  syllableIndex: number;
  syllable: string;
  role: string;
}

/** 텍스트 → 자모 토큰 목록. 공백(반각·전각) 제거, NFC. */
export function decompose(text: string): JamoItem[] {
  const norm = text.normalize('NFC').replace(/ /g, '').replace(/　/g, '');
  const out: JamoItem[] = [];
  const chars = [...norm];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const o = ch.codePointAt(0)!;
    if (o >= 0xac00 && o <= 0xd7a3) {
      const s = o - 0xac00;
      const cho = Math.floor(s / 588);
      const jung = Math.floor((s % 588) / 28);
      const jong = s % 28;
      out.push({ jamo: CHO[cho], syllableIndex: i, syllable: ch, role: '초성' });
      out.push({ jamo: JUNG[jung], syllableIndex: i, syllable: ch, role: '중성' });
      if (jong) out.push({ jamo: JONG[jong], syllableIndex: i, syllable: ch, role: '종성' });
    } else {
      const role = o >= 0x3131 && o <= 0x3163 ? '자모' : '문자';
      out.push({ jamo: ch, syllableIndex: i, syllable: ch, role });
    }
  }
  return out;
}

export function compare(ocrText: string, targetWord: string): CompareResult {
  const t = decompose(targetWord);
  const h = decompose(ocrText);
  const n = t.length;
  const m = h.length;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) d.push(new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = t[i - 1].jamo === h[j - 1].jamo ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j - 1] + c, // 치환/일치
        d[i - 1][j] + 1, // 정답 자모 누락
        d[i][j - 1] + 1 // 잉여 자모 추가
      );
    }
  }
  // 역추적 (누락 우선 → 일치/치환 → 추가 — 동순위 누락을 낱말 끝쪽에 귀속)
  const errors: JamoError[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      const it = t[i - 1];
      errors.push({
        type: 'missing',
        syllable_index: it.syllableIndex,
        syllable: it.syllable,
        role: it.role,
        expected: it.jamo,
        written: null,
      });
      i -= 1;
    } else if (
      i > 0 &&
      j > 0 &&
      d[i][j] === d[i - 1][j - 1] + (t[i - 1].jamo === h[j - 1].jamo ? 0 : 1)
    ) {
      if (t[i - 1].jamo !== h[j - 1].jamo) {
        const it = t[i - 1];
        errors.push({
          type: 'wrong',
          syllable_index: it.syllableIndex,
          syllable: it.syllable,
          role: it.role,
          expected: it.jamo,
          written: h[j - 1].jamo,
        });
      }
      i -= 1;
      j -= 1;
    } else {
      const ih = h[j - 1];
      const anchor = i > 0 ? t[i - 1].syllableIndex : 0;
      errors.push({
        type: 'extra',
        syllable_index: anchor,
        syllable: i > 0 ? t[i - 1].syllable : '',
        role: ih.role,
        expected: null,
        written: ih.jamo,
      });
      j -= 1;
    }
  }
  errors.reverse();
  const dist = d[n][m];
  return {
    distance: dist,
    correct: dist === 0,
    errors,
    message: buildMessage(targetWord, dist, errors, Math.abs(n - m)),
  };
}

function buildMessage(target: string, dist: number, errors: JamoError[], lenGap: number): string {
  if (dist === 0) return '정답이에요! 참 잘 썼어요.';
  if (dist >= 3 || lenGap >= 3) return `'${target}'를 다시 한 번 잘 보고 처음부터 써 볼까요?`;
  const e = errors[0];
  const ordinal = `${e.syllable_index + 1}번째 글자`;
  if (e.type === 'wrong') {
    return `'${target}'의 ${ordinal} '${e.syllable}'에서 ${e.role} '${e.expected}'를 살펴보세요. '${e.written}'라고 쓰여 있어요.`;
  }
  if (e.type === 'missing') {
    return `'${target}'의 ${ordinal} '${e.syllable}'에 ${e.role} '${e.expected}'가 빠졌어요.`;
  }
  return `'${target}'의 ${ordinal} 근처에 '${e.written}'가 더 쓰여 있어요. 한 번 더 볼까요?`;
}
