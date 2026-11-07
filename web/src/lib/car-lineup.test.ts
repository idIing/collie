import { describe, expect, test } from "vitest";

import { inLineup, nextLineup } from "./car-lineup";
import { paneRowKey } from "./hosts";
import type { AgentView } from "./types";

const NOW = 1_000_000_000;
const pane = (paneId: string, over: Partial<AgentView> = {}): AgentView => ({
  paneId,
  workspaceId: "w",
  workspaceLabel: "w",
  workspaceNumber: 1,
  tabId: "t",
  agent: "claude",
  status: "idle",
  cwd: "/",
  focused: false,
  ...over,
});
const warm = (expiresIn: number) => ({ state: "warm" as const, expiresAt: NOW + expiresIn, ttlSeconds: 300, ruleId: "r", confidence: "observed" as const });

describe("car lineup", () => {
  test("busy panes and warm caches are in; cold, idle and shell panes are out", () => {
    expect(inLineup(pane("a", { status: "working" }), NOW)).toBe(true);
    expect(inLineup(pane("b", { status: "blocked" }), NOW)).toBe(true);
    expect(inLineup(pane("c", { cache: warm(60_000) }), NOW)).toBe(true);
    expect(inLineup(pane("d", { cache: { ...warm(0), state: "cold" } }), NOW)).toBe(false);
    expect(inLineup(pane("e", { kind: "shell", status: "working" }), NOW)).toBe(false);
  });

  test("order holds; a newcomer joins at the left; the pane on screen never drops out", () => {
    const a = pane("a", { status: "working" });
    const b = pane("b", { status: "working" });
    const c = pane("c", { status: "working", lastActiveAt: 5 });
    const here = pane("h");
    const first = nextLineup([], [a, b], paneRowKey(a), NOW);
    expect(nextLineup(first, [a, b, c], paneRowKey(a), NOW)).toEqual([paneRowKey(c), ...first]);
    expect(nextLineup(first, [a, b, here], paneRowKey(here), NOW)).toContain(paneRowKey(here));
  });
});
