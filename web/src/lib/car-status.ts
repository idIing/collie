import type { AgentStatus } from "./types";

// What Play would read, said before it is pressed. Herdr's pane status tells a FINAL reply (the agent
// stopped) from a progress note (it is still working, so the latest reply is a "let me check…" between
// tool calls), and an empty pane from either.

export interface CarStatusLine {
  /** The state, one word: shown beside the status shape, never hue alone. */
  word: string;
  /** What Play reads in this state. */
  play: string;
}

export function carStatusLine(status: AgentStatus, hasReply: boolean): CarStatusLine {
  if (!hasReply) {
    return status === "working"
      ? { word: "Working", play: "New chat: nothing to read yet." }
      : { word: "New chat", play: "Nothing to read yet." };
  }
  switch (status) {
    case "working":
      return { word: "Working", play: "Play reads a progress note, not the final answer." };
    case "blocked":
      return { word: "Needs you", play: "Play reads the latest message before it stopped to ask." };
    case "idle":
    case "done":
      return { word: "Stopped", play: "Play reads the final reply." };
    case "unknown":
      return { word: "Status unknown", play: "Play reads the latest reply." };
  }
}
