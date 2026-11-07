import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Play } from "lucide-react";

import { segmentAt, spanText, type CarScript, type CarSegment } from "@/lib/car-script";
import type { CarFeedItem } from "@/lib/car-feed";
import { shownRange } from "@/lib/car-speech";
import type { CarWord } from "@/lib/car-clock";

// Car mode's DOCUMENT: the pane's final replies as one wrapped feed, the operator's own turns as thin
// dividers between them. The reply being read marks its spoken word by weight and an underline, a
// table cell or code block by a heavy outline — never by hue alone.
//
// Nothing here runs off to the right: prose wraps anywhere it must (a path also breaks after each
// slash), code wraps its lines, and only a wide table scrolls, sideways inside its own box
// (`data-hscroll`, which the view's swipe leaves alone), following the cell being read.

export interface CarActive {
  uuid: string;
  word: CarWord;
}

/** How long after a manual scroll the document stops following the spoken word. */
const FOLLOW_PAUSE_MS = 4000;

/** Text that may break after every slash, so a long path wraps at its own seams. */
function breakable(text: string): ReactNode {
  if (!text.includes("/")) return text;
  return text.split("/").map((part, i, all) => (
    <Fragment key={i}>
      {part}
      {i < all.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
}

function ProseSeg({ seg, spoken }: { seg: CarSegment; spoken: { s: number; e: number } | null }) {
  const shown = seg.shown;
  if (!spoken) return <>{breakable(shown)}</>;
  const [from, to] = shownRange(seg.subs, spoken.s, spoken.e, shown.length);
  return (
    <>
      {breakable(shown.slice(0, from))}
      <span data-car-word className="font-black underline decoration-4 underline-offset-[0.2em]">
        {breakable(shown.slice(from, to))}
      </span>
      {breakable(shown.slice(to))}
    </>
  );
}

function Reply({ script, active }: { script: CarScript; active: CarWord | null }) {
  const seg = active ? segmentAt(script, active.offset) : null;
  const spokenIn = (s: CarSegment) =>
    seg === s && active ? { s: active.offset - s.start, e: active.offset - s.start + active.length } : null;
  const segsOf = (b: number) => script.segments.filter((s) => s.target.block === b);

  return (
    <>
      {script.blocks.map((block, b) => {
        const segs = segsOf(b);
        const here = seg?.target.block === b;
        switch (block.kind) {
          case "heading":
            return (
              <h3 key={b} className="mt-4 text-[1.15em] font-bold">
                {segs[0] && <ProseSeg seg={segs[0]} spoken={spokenIn(segs[0])} />}
              </h3>
            );
          case "paragraph":
            return <p key={b} className="mt-3">{segs[0] && <ProseSeg seg={segs[0]} spoken={spokenIn(segs[0])} />}</p>;
          case "quote":
            return (
              <blockquote key={b} className="mt-3 border-l-4 border-foreground pl-3 italic">
                {segs[0] && <ProseSeg seg={segs[0]} spoken={spokenIn(segs[0])} />}
              </blockquote>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={b} className={`mt-3 pl-[1.2em] ${block.ordered ? "list-decimal" : "list-disc"}`} start={block.start}>
                {block.items.map((_, row) => {
                  const s = segs.find((x) => "row" in x.target && x.target.row === row);
                  return <li key={row}>{s && <ProseSeg seg={s} spoken={spokenIn(s)} />}</li>;
                })}
              </Tag>
            );
          }
          case "code":
            return (
              <pre
                key={b}
                data-car-word={here ? "" : undefined}
                className={`mt-3 rounded-lg border-2 p-3 font-mono text-[0.7em] whitespace-pre-wrap [overflow-wrap:anywhere] ${here ? "border-foreground outline outline-4 outline-foreground" : "border-rule"}`}
              >
                {block.text}
              </pre>
            );
          case "table": {
            const at = here && seg && "row" in seg.target ? seg.target : null;
            return (
              <div key={b} data-hscroll className="mt-3 touch-pan-x touch-pan-y overflow-x-auto">
                <table className="border-collapse text-[0.8em]">
                  <thead>
                    <tr>
                      {block.header.map((h, c) => (
                        <th key={c} className="border-b-2 border-foreground p-2 text-left whitespace-nowrap">{spanText(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((cells, r) => (
                      <tr key={r} className={at?.row === r ? "font-semibold" : ""}>
                        {cells.map((cell, c) => {
                          const on = at?.row === r && at.col === c;
                          return (
                            <td
                              key={c}
                              data-car-word={on ? "" : undefined}
                              className={`border-b border-rule p-2 whitespace-nowrap ${on ? "font-black outline outline-4 -outline-offset-4 outline-foreground" : ""}`}
                            >
                              {spanText(cell)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "rule":
            return <hr key={b} className="mt-3 border-rule" />;
        }
      })}
    </>
  );
}

export function CarDocument({
  feed,
  scripts,
  active,
  current,
  scale,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onPlayFrom,
}: {
  feed: CarFeedItem[];
  /** The script each reply is shown from, by uuid: the same one its audio was rendered from. */
  scripts: (uuid: string) => CarScript;
  active: CarActive | null;
  /** The reply that is loaded for playback, marked even while paused. */
  current: string | null;
  /** Pinch-chosen text size, 1 = the base size. */
  scale: number;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onPlayFrom: (uuid: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const top = useRef<HTMLDivElement | null>(null);
  const userScrolledAt = useRef(0);
  const firstFill = useRef(true);
  const heightBefore = useRef<number | null>(null);

  // The newest reply is at the bottom: open there, once there is something to show.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || feed.length === 0) return;
    if (firstFill.current) {
      firstFill.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Older replies were added above: keep the reading where it was.
    if (heightBefore.current !== null) {
      el.scrollTop += el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
    }
  }, [feed]);

  // Scrolling near the top asks for the page before it.
  useEffect(() => {
    const el = top.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting) && !loadingOlder) {
        heightBefore.current = box.current?.scrollHeight ?? null;
        onLoadOlder();
      }
    }, { root: box.current, rootMargin: "400px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingOlder, onLoadOlder]);

  // Follow the spoken word, unless the operator scrolled a moment ago: only when it leaves the
  // middle half of the view, so the text holds still for a glance between moves.
  useEffect(() => {
    const el = box.current;
    if (!el || !active || Date.now() - userScrolledAt.current < FOLLOW_PAUSE_MS) return;
    const mark = el.querySelector("[data-car-word]");
    if (!mark) return;
    const view = el.getBoundingClientRect();
    const at = mark.getBoundingClientRect();
    if (at.top < view.top + view.height * 0.25 || at.bottom > view.top + view.height * 0.75) {
      mark.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }, [active]);

  const touched = () => {
    userScrolledAt.current = Date.now();
  };

  return (
    <div
      ref={box}
      onTouchMove={touched}
      onWheel={touched}
      className="h-full touch-pan-x touch-pan-y overflow-y-auto overscroll-contain px-4 pb-6 leading-snug [overflow-wrap:anywhere]"
      style={{ fontSize: `${1.5 * scale}rem` }}
    >
      <div ref={top} />
      {hasMore && <p className="py-2 text-center text-[0.6em] text-muted-foreground">{loadingOlder ? "Loading older…" : "Scroll up for older"}</p>}
      {feed.length === 0 && <p className="mt-8 text-muted-foreground">No reply in this pane yet.</p>}
      {feed.map((item) =>
        item.kind === "you" ? (
          <div key={item.entry.uuid} className="mt-6 flex items-center gap-2 text-[0.6em] text-muted-foreground">
            <span className="h-px flex-1 bg-rule" />
            <span className="line-clamp-2 max-w-[80%] font-semibold">you: {item.text}</span>
            <span className="h-px flex-1 bg-rule" />
          </div>
        ) : (
          <article key={item.entry.uuid} className="mt-3">
            <button
              type="button"
              onClick={() => onPlayFrom(item.entry.uuid)}
              className={`flex h-11 items-center gap-2 rounded-lg px-2 text-[0.6em] font-semibold ${current === item.entry.uuid ? "border-2 border-foreground" : "text-muted-foreground"}`}
            >
              <Play className="size-5" />
              {current === item.entry.uuid ? "Current · play from start" : "Play from here"}
              {item.progress && <span className="font-bold">· progress note, agent still working</span>}
            </button>
            <Reply script={scripts(item.entry.uuid)} active={active?.uuid === item.entry.uuid ? active.word : null} />
          </article>
        ),
      )}
    </div>
  );
}
