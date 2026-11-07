import { replyProse } from "./latest-reply";
import type { AgentStatus, TranscriptEntry } from "./types";

// Car mode's document: the agent's FINAL replies with the operator's own turns between them, oldest
// first. A final reply is the last prose the agent wrote before the operator's next turn, so the
// "let me check…" notes it writes between tool calls are left out.
//
// The newest turn is the exception that decides itself by status: while the agent is still working
// its latest prose is a progress note, and it is still shown, LAST, because it is what Play reads now
// (and the status line says so). Once the agent stops, that same entry is the turn's final reply.

export type CarFeedItem =
  | { kind: "you"; entry: TranscriptEntry; text: string }
  | { kind: "reply"; entry: TranscriptEntry; /** The newest turn's latest prose while the agent is still working. */ progress: boolean };

/** The operator's own words in a user entry; "" for a user entry that only carries tool results. */
function youText(entry: TranscriptEntry): string {
  return replyProse(entry);
}

export function carFeed(entries: readonly TranscriptEntry[], status: AgentStatus): CarFeedItem[] {
  const out: CarFeedItem[] = [];
  let last: TranscriptEntry | null = null;
  const close = () => {
    if (last) out.push({ kind: "reply", entry: last, progress: false });
    last = null;
  };
  for (const entry of entries) {
    if (entry.abandoned === true) continue;
    if (entry.role === "user") {
      const text = youText(entry);
      if (!text) continue;
      close();
      out.push({ kind: "you", entry, text });
    } else if (entry.role === "assistant" && replyProse(entry) !== "") {
      last = entry;
    }
  }
  if (last) out.push({ kind: "reply", entry: last, progress: status === "working" });
  return out;
}

/** The replies in reading order: what ⏮ ⏭ step through and what plays on into the next. */
export function feedReplies(feed: readonly CarFeedItem[]): TranscriptEntry[] {
  return feed.flatMap((item) => (item.kind === "reply" ? [item.entry] : []));
}
