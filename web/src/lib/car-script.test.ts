import { describe, expect, test } from "vitest";

import { buildCarScript, segmentAt, speakTableRow } from "./car-script";
import type { TranscriptEntry } from "./types";

const reply = (text: string): TranscriptEntry => ({ uuid: "u1", ts: "", role: "assistant", parts: [{ kind: "text", text }] });

describe("car script", () => {
  test("a table row reads column name then value, and each piece points at its cell", () => {
    expect(speakTableRow(["A", "P(A)"], ["true", "0.3"])).toEqual([
      { col: 0, text: "A, true" },
      { col: 1, text: "P(A), 0.3" },
    ]);
    expect(speakTableRow(["A", "B"], ["", "x"])).toEqual([{ col: 1, text: "B, x" }]);
  });

  test("segments cover the text in order and map offsets back to blocks and cells", () => {
    const s = buildCarScript(reply("Intro line\n\n| A | P(A) |\n|---|---|\n| true | 0.3 |\n"));
    expect(s.text).toBe("Intro line. A, true; P(A), 0.3.");
    expect(segmentAt(s, s.text.indexOf("Intro"))?.target).toEqual({ block: 0 });
    expect(segmentAt(s, s.text.indexOf("0.3"))?.target).toEqual({ block: 1, row: 0, col: 1 });
  });

  test("a quote is one segment holding its nested prose", () => {
    const s = buildCarScript(reply("> First line\n>\n> > Nested"));
    expect(s.text).toBe("First line. Nested.");
    expect(s.segments).toEqual([{ start: 0, end: s.text.length, target: { block: 0 } }]);
  });
});
