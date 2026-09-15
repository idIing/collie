import { describe, expect, it } from "vitest";

import { replySpeechChunks } from "./reply-speech";
import type { TranscriptEntry } from "./types";

function reply(text: string, parts: TranscriptEntry["parts"] = [{ kind: "text", text }]): TranscriptEntry {
  return { uuid: "reply-1", role: "assistant", ts: "2026-09-15T12:00:00Z", parts };
}

describe("replySpeechChunks", () => {
  it("keeps prose and useful inline text without reading Markdown notation or link targets", () => {
    expect(
      replySpeechChunks(
        reply("## Result\n\nUse **Collie** with `speechSynthesis` and [open Settings](https://example.com/settings)."),
      ),
    ).toEqual(["Result", "Use Collie with speechSynthesis and open Settings."]);
  });

  it("omits fenced code, tables, and rules while keeping prose and list items", () => {
    expect(
      replySpeechChunks(
        reply(
          "Before.\n\n```ts\nconst secret = 42;\n```\n\n- First step\n- Second step\n\n| Key | Value |\n| --- | --- |\n| token | secret |\n\n---\n\nAfter.",
        ),
      ),
    ).toEqual(["Before.", "First step", "Second step", "After."]);
  });

  it("uses only reply prose, never thinking or tool payloads", () => {
    expect(
      replySpeechChunks(
        reply("", [
          { kind: "thinking", text: "private reasoning" },
          { kind: "tool", name: "shell", summary: "dangerous and noisy payload" },
          { kind: "text", text: "Finished answer." },
        ]),
      ),
    ).toEqual(["Finished answer."]);
  });

  it("returns no utterances for a code-only answer", () => {
    expect(replySpeechChunks(reply("```sh\nbun test\n```"))).toEqual([]);
  });
});
