/**
 * 정답 대조기 골든 76벡터 러너 — 포팅 계약: distance/correct/first_error_type/
 * first_error_role/first_error_syllable_index 5필드 전부 일치(76/76) 필수.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare } from '../src/core/jamo';
import { parseCsv } from './csv';

const rows = parseCsv(readFileSync(join(__dirname, 'fixtures', 'test_vectors.csv'), 'utf-8'));

describe('jamo matcher golden vectors', () => {
  it('has 76 vectors', () => {
    expect(rows.length).toBe(76);
  });

  let pass = 0;
  for (const row of rows) {
    it(`${row.test_id} [${row.category}] '${row.ocr_text}' vs '${row.target_word}'`, () => {
      const r = compare(row.ocr_text, row.target_word);
      expect(r.distance).toBe(Number(row.expected_distance));
      expect(r.correct ? '1' : '0').toBe(row.expected_correct);
      const first = r.errors[0];
      expect(first?.type ?? '').toBe(row.first_error_type);
      expect(first?.role ?? '').toBe(row.first_error_role);
      expect(first ? String(first.syllable_index) : '').toBe(row.first_error_syllable_index);
      pass++;
    });
  }

  it('summary: 76/76', () => {
    expect(pass).toBe(76);
  });
});
