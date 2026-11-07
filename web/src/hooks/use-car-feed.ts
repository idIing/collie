import { useCallback, useEffect, useState } from "react";

import { fetchHistory } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { TranscriptEntry } from "@/lib/types";

// The pane's transcript for car mode's document: the newest page, re-read when something changed
// (`trigger`: the latest reply's id and the pane's status), and older pages on demand as the
// operator scrolls up. Like use-latest-reply.ts it never reads on the poll.

/** Entries per page. Tool-heavy turns are many entries for one reply, so a page is generous. */
const PAGE = 300;

export interface CarFeedData {
  entries: TranscriptEntry[];
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** False when the pane has no readable session log. */
  available: boolean;
}

export function useCarFeedData({ paneId, scope, trigger }: { paneId: string; scope?: Scope; trigger: string }): CarFeedData {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [available, setAvailable] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const page = await fetchHistory(paneId, { limit: PAGE }, scope, abort.signal);
        if (abort.signal.aborted) return;
        if (!page.available) {
          setAvailable(false);
          return;
        }
        setAvailable(true);
        // Older pages already loaded stay: the fresh newest page replaces the tail it overlaps.
        const first = page.entries[0]?.uuid;
        setEntries((cur) => {
          const at = first === undefined ? -1 : cur.findIndex((e) => e.uuid === first);
          if (at < 0) setHasMore(page.hasMore);
          return at < 0 ? page.entries : [...cur.slice(0, at), ...page.entries];
        });
      } catch {
        // A failed read keeps what is on screen.
      }
    })();
    return () => abort.abort();
  }, [paneId, scope, trigger]);

  const loadOlder = useCallback(() => {
    const before = entries[0]?.uuid;
    if (!hasMore || loadingOlder || before === undefined) return;
    setLoadingOlder(true);
    void (async () => {
      try {
        const page = await fetchHistory(paneId, { limit: PAGE, before }, scope);
        if (!page.available) return;
        setEntries((cur) => [...page.entries, ...cur]);
        setHasMore(page.hasMore);
      } catch {
        // Try again on the next scroll.
      } finally {
        setLoadingOlder(false);
      }
    })();
  }, [entries, hasMore, loadingOlder, paneId, scope]);

  return { entries, hasMore, loadingOlder, loadOlder, available };
}
