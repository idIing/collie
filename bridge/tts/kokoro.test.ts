import { describe, expect, test } from "bun:test";

import { alignWords, applyLexicon } from "./kokoro.ts";

const ts = (words: string[]) => words.map((word, i) => ({ word, start_time: i, end_time: i + 0.9 }));

describe("alignWords", () => {
  test("maps spoken words to written offsets in order", () => {
    const text = "The Markov blanket.";
    const out = alignWords(text, ts(["The", "Markov", "blanket", "."]));
    expect(out.map((w) => text.slice(w.offset, w.offset + w.length))).toEqual(["The", "Markov", "blanket."]);
  });

  test("a normalizer's expansion lands on the digit token it expanded", () => {
    const text = "line 42 here";
    const out = alignWords(text, ts(["line", "forty", "two", "here"]));
    expect(out.map((w) => text.slice(w.offset, w.offset + w.length))).toEqual(["line", "42", "here"]);
    expect(out[1]).toMatchObject({ start: 1, end: 2.9 });
  });

  test("an unmatched word before plain prose rides on the word before it", () => {
    const text = "the blanket";
    const out = alignWords(text, ts(["the", "uh", "blanket"]));
    expect(out.map((w) => text.slice(w.offset, w.offset + w.length))).toEqual(["the", "blanket"]);
  });
});

describe("applyLexicon", () => {
  test("wraps whole-word terms in Kokoro's IPA markup", () => {
    expect(applyLexicon("run kubectl, not kubectls", { kubectl: "kjˈuːbkɛtəl" })).toBe(
      "run [kubectl](/kjˈuːbkɛtəl/), not kubectls",
    );
  });
});
