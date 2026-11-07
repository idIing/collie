import { describe, expect, test } from "vitest";

import { carFeed, feedReplies } from "./car-feed";
import type { TranscriptEntry } from "./types";

const e = (uuid: string, role: TranscriptEntry["role"], text: string): TranscriptEntry => ({
  uuid,
  ts: "",
  role,
  parts: text ? [{ kind: "text", text }] : [{ kind: "tool", name: "Read", summary: "x" }],
});

const log = [
  e("u1", "user", "first question"),
  e("a1", "assistant", "let me check"),
  e("t1", "assistant", ""),
  e("a2", "assistant", "the answer"),
  e("r1", "user", ""),
  e("u2", "user", "second"),
  e("a3", "assistant", "working on it"),
];

describe("car feed", () => {
  test("keeps the last prose of each turn and your turns; drops progress notes and tool-only rows", () => {
    const feed = carFeed(log, "idle");
    expect(feed.map((i) => i.entry.uuid)).toEqual(["u1", "a2", "u2", "a3"]);
    expect(feedReplies(feed).map((r) => r.uuid)).toEqual(["a2", "a3"]);
  });

  test("the newest turn's prose is a progress note while the agent works", () => {
    const last = carFeed(log, "working").at(-1);
    expect(last).toMatchObject({ kind: "reply", progress: true });
    expect(carFeed(log, "blocked").at(-1)).toMatchObject({ kind: "reply", progress: false });
  });
});
