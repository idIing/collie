import { cacheChipView } from "./cache-view";
import { paneRowKey } from "./hosts";
import { activityAt } from "./pane-order";
import type { AgentView } from "./types";

// The agents car mode swipes between: the ones with something going on, in a STABLE order.
//
// Stable the way lib/pane-order.ts is frozen: an agent keeps its slot while car mode is open, so a
// swipe never lands somewhere other than where it did a minute ago. A newly active agent joins at the
// far LEFT (the newest thing is where the eye starts); one that goes quiet drops out, and if it wakes
// again it joins at the left like any newcomer. The first reading is activity order, newest first.

/** A pane with no cache reading counts as active this long after anything last happened in it. */
const UNMEASURED_ACTIVE_MS = 30 * 60_000;

/**
 * Whether a pane belongs in the swipe right now: busy, or its prompt cache still warm.
 *
 * `now` is the page clock in epoch ms (the cache reading's `expiresAt` is on the same clock).
 */
export function inLineup(pane: AgentView, now: number): boolean {
  if (pane.kind === "shell") return false;
  if (pane.status === "working" || pane.status === "blocked") return true;
  const warm = cacheWarm(pane, now);
  // A harness that reports no cache falls back to recent activity, the same reading the pane list's
  // activity sort uses.
  return warm ?? now - activityAt(pane) < UNMEASURED_ACTIVE_MS;
}

/**
 * The next lineup, as row keys, from the previous one. `here` (the pane on screen) is always in it,
 * so the agent you are listening to never vanishes from under you.
 */
export function nextLineup(prev: readonly string[], panes: readonly AgentView[], here: string, now: number): string[] {
  const members = new Map<string, AgentView>();
  for (const p of panes) if (paneRowKey(p) === here || inLineup(p, now)) members.set(paneRowKey(p), p);
  const kept = prev.filter((k) => members.has(k));
  const joining = [...members.values()]
    .filter((p) => !kept.includes(paneRowKey(p)))
    .toSorted((a, b) => activityAt(b) - activityAt(a))
    .map(paneRowKey);
  return [...joining, ...kept];
}

/** Whether a cache reading still has a warm prompt behind it (the chip's own rule, lib/cache-view.ts). */
export function cacheWarm(pane: AgentView, now: number): boolean | null {
  const view = cacheChipView(pane.cache, now);
  return view === null ? null : view.tone !== "cold";
}
