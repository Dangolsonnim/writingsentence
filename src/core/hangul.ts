/**
 * jamo_no_null 토큰열 → 한글 음절 결합. (OnnxOcrEngine의 HangulComposer.kt 동작 동등 포팅)
 * code = 0xAC00 + (cho*21 + jung)*28 + jong  (jong=0=받침없음)
 * 토큰은 "CHO_ㄱ" / "JUNG_ㅏ" / "JONG_ㄱ" 형태이며 vocab 등장 순서로 인덱스를 만든다.
 */
export class HangulComposer {
  private choIndex = new Map<string, number>();
  private jungIndex = new Map<string, number>();
  private jongIndex = new Map<string, number>(); // 1-based (0=없음)

  constructor(vocab: string[]) {
    let c = 0;
    let j = 0;
    let t = 1;
    for (const token of vocab) {
      if (token.startsWith('CHO_')) this.choIndex.set(token.slice(4), c++);
      else if (token.startsWith('JUNG_')) this.jungIndex.set(token.slice(5), j++);
      else if (token.startsWith('JONG_')) this.jongIndex.set(token.slice(5), t++);
    }
  }

  compose(tokens: string[]): string {
    let sb = '';
    let cho: string | null = null;
    let jung: string | null = null;
    let jong: string | null = null;

    const flush = () => {
      if (cho === null && jung === null && jong === null) return;
      if (cho !== null && jung !== null && this.choIndex.has(cho) && this.jungIndex.has(jung)) {
        const ci = this.choIndex.get(cho)!;
        const ji = this.jungIndex.get(jung)!;
        const ti = jong !== null ? this.jongIndex.get(jong) ?? 0 : 0;
        sb += String.fromCharCode(0xac00 + (ci * 21 + ji) * 28 + ti);
      } else {
        // 불완전 음절은 호환 자모 그대로
        if (cho !== null) sb += cho;
        if (jung !== null) sb += jung;
        if (jong !== null) sb += jong;
      }
      cho = null;
      jung = null;
      jong = null;
    };

    for (const token of tokens) {
      if (token.startsWith('CHO_')) {
        const v = token.slice(4);
        if (cho === null && jung === null && jong === null) cho = v;
        else {
          flush();
          cho = v;
        }
      } else if (token.startsWith('JUNG_')) {
        const v = token.slice(5);
        if (cho !== null && jung === null) jung = v;
        else {
          flush();
          jung = v;
        }
      } else if (token.startsWith('JONG_')) {
        const v = token.slice(5);
        if (cho !== null && jung !== null && jong === null) {
          jong = v;
          flush();
        } else {
          flush();
          sb += v;
        }
      } else if (token.startsWith('<')) {
        // 특수토큰 무시
      } else {
        flush();
        sb += token; // 숫자/기호/공백 등 그대로
      }
    }
    flush();
    return sb.normalize('NFC');
  }
}

/** tokenizer.json(jamo_no_null) 파서 — CrnnTokenizer.kt 동등. */
export class CrnnTokenizer {
  constructor(
    public readonly vocab: string[],
    public readonly blankIndex: number
  ) {}

  get size(): number {
    return this.vocab.length;
  }

  tokenAt(index: number): string {
    return index >= 0 && index < this.vocab.length ? this.vocab[index] : '<UNK>';
  }

  static fromJson(json: string): CrnnTokenizer {
    const obj = JSON.parse(json) as { vocab: string[] };
    const blank = obj.vocab.indexOf('<BLANK>');
    return new CrnnTokenizer(obj.vocab, blank >= 0 ? blank : 4);
  }
}
