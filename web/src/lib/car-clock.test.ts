import { describe, expect, test } from "vitest";

import { snapSeek, wordAt } from "./car-clock";

const words = [0, 0.5, 1.2, 6.0, 6.4].map((start, i) => ({ start, end: start + 0.4, offset: i * 4, length: 3 }));

describe("car clock", () => {
  test("wordAt is the last word that has started", () => {
    expect(wordAt(words, -1)).toBe(-1);
    expect(wordAt(words, 1.3)).toBe(2);
    expect(wordAt(words, 99)).toBe(4);
  });
  test("a seek lands on the start of the word in progress, clamped", () => {
    expect(snapSeek(words, 6.2, 7)).toBe(6.0);
    expect(snapSeek(words, 1.3 - 5, 7)).toBe(0);
    expect(snapSeek(words, 50, 7)).toBe(6.4);
  });
});
