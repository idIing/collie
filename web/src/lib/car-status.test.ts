import { describe, expect, test } from "vitest";

import { carStatusLine } from "./car-status";

describe("car status line", () => {
  test("a working pane's latest reply is a progress note; a stopped one's is final", () => {
    expect(carStatusLine("working", true)).toEqual({ word: "Working", play: "Play reads a progress note, not the final answer." });
    expect(carStatusLine("idle", true).word).toBe("Stopped");
    expect(carStatusLine("done", true).play).toBe("Play reads the final reply.");
    expect(carStatusLine("blocked", true).word).toBe("Needs you");
  });

  test("a pane with no reply is a new chat", () => {
    expect(carStatusLine("idle", false).word).toBe("New chat");
    expect(carStatusLine("working", false).play).toBe("New chat: nothing to read yet.");
  });
});
