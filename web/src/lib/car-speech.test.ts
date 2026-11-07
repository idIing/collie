import { describe, expect, test } from "vitest";

import { shownRange, speakable, speakPath } from "./car-speech";

describe("car speech", () => {
  test("a path is said as its deepest two parts", () => {
    expect(speakPath("/home/idle/projects/balatro/alpha-balatro")).toBe("balatro/alpha-balatro");
    expect(speakPath("~/boxes/bin/projbox")).toBe("bin/projbox");
    expect(speakPath("web/src/lib/car-view.tsx")).toBe("lib/car-view.tsx");
  });

  test("short paths, URLs and plain words are left alone", () => {
    expect(speakable("see src/x.ts and/or https://a.b/c/d/e").spoken).toBe("see src/x.ts and/or https://a.b/c/d/e");
  });

  test("a word inside a shortened path marks the whole path on screen; words after it shift back", () => {
    const shown = "Open /home/idle/projects/balatro/alpha-balatro now";
    const { spoken, subs } = speakable(shown);
    expect(spoken).toBe("Open balatro/alpha-balatro now");
    const inPath = spoken.indexOf("alpha");
    expect(shownRange(subs, inPath, inPath + 5, shown.length)).toEqual([5, shown.indexOf(" now")]);
    const nowAt = spoken.indexOf("now");
    const [a, b] = shownRange(subs, nowAt, nowAt + 3, shown.length);
    expect(shown.slice(a, b)).toBe("now");
  });

  test("the stop a sentence adds past the shown text marks nothing beyond it", () => {
    expect(shownRange([], 10, 11, 10)).toEqual([10, 10]);
  });
});
