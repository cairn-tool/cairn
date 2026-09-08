const SS3: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_SEQ: Readonly<Record<string, string>> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[5~": "pgup",
  "[6~": "pgdn",
  "[1~": "home",
  "[4~": "end",
  "[7~": "home",
  "[8~": "end",
};

const TILDE_CODES: Readonly<Record<string, string>> = {
  "5": "pgup",
  "6": "pgdn",
  "1": "home",
  "4": "end",
  "7": "home",
  "8": "end",
};

/** Turn raw stdin bytes into named keys, including CSI/SS3 arrows and paging. */
export class KeyDecoder {
  private buf = "";

  get pending(): boolean {
    return this.buf.length > 0;
  }

  push(data: string): string[] {
    this.buf += data;
    const keys: string[] = [];
    while (this.buf.length > 0) {
      const [key, n] = this.match(this.buf);
      if (n === 0) break;
      if (key) keys.push(key);
      this.buf = this.buf.slice(n);
    }
    return keys;
  }

  /**
   * Called on the 250 ms read timeout: a buffer holding exactly ESC is a real Escape keypress
   * rather than the start of a sequence that has not arrived yet.
   */
  flush(): string[] {
    if (this.buf === "\x1b") {
      this.buf = "";
      return ["esc"];
    }
    return [];
  }

  private match(s: string): [string, number] {
    if (s[0] !== "\x1b") {
      // Python yields a whole code point here; JS indexing would split an astral pair
      // (a pasted emoji) into two lone surrogates.
      const ch = String.fromCodePoint(s.codePointAt(0)!);
      return [ch, ch.length];
    }
    if (s.length === 1) return ["", 0];
    if (s[1] === "O") {
      if (s.length < 3) return ["", 0];
      return [SS3[s[2]!] ?? "", 3];
    }
    if (s[1] !== "[") return ["esc", 1];
    let i = 2;
    while (i < s.length && (/[0-9]/.test(s[i]!) || s[i] === ";")) i += 1;
    if (i >= s.length) return ["", 0];
    const seq = s.slice(1, i + 1);
    const mapped = CSI_SEQ[seq];
    if (mapped) return [mapped, i + 1];
    const final = s[i]!;
    if (final in SS3) return [SS3[final]!, i + 1];
    if (final === "~") {
      const code = seq.slice(1).replace(/~+$/, "").split(";")[0] ?? "";
      return [TILDE_CODES[code] ?? "", i + 1];
    }
    return ["", i + 1];
  }
}
