import { replyProse } from "./latest-reply";
import { parseMarkdown, type MdBlock, type MdSpan } from "./markdown";
import { speakable, type SpeechSub } from "./car-speech";
import type { TranscriptEntry } from "./types";

// Car mode speaks a reply as ONE text, so the timeline, the captions and the highlight all read one
// clock. Each stretch of that text remembers what it came from — a block, or a table cell — so the
// word the engine is saying maps back to the thing on screen to mark.
//
// The engine returns words with character offsets into `text` (bridge/tts). An offset finds its
// segment by binary search; the segment names the target.

/** What a stretch of spoken text points at. `row` −1 is the header row. */
export type CarTarget = { block: number } | { block: number; row: number; col: number };

/** `[start, end)` in {@link CarScript.text}. */
export interface CarSegment {
  start: number;
  end: number;
  target: CarTarget;
  /** The text this stretch shows on screen (prose, a list item), or "" when the block draws itself. */
  shown: string;
  /** Spoken-to-shown substitutions, offsets relative to `start` and to `shown` (lib/car-speech.ts). */
  subs: SpeechSub[];
}

export interface CarScript {
  /** The blocks as rendered, so a target's `block` indexes straight into them. */
  blocks: MdBlock[];
  /** Everything the engine is asked to say, in reading order. */
  text: string;
  /** Sorted, non-overlapping. Connector words a builder adds ("row two") are segments too. */
  segments: CarSegment[];
}

/** One spoken piece of a table row, tied to a column, or to no cell (connector words). */
export interface RowPiece {
  col: number | null;
  text: string;
}

export function spanText(spans: MdSpan[]): string {
  return spans
    .map((span) => {
      if (span.kind === "text" || span.kind === "code") return span.text;
      if (span.kind === "image") return span.alt;
      return "spans" in span ? spanText(span.spans) : "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How one body row of a table is said aloud.
 *
 * `header` and `cells` are the plain text of each column. Return the pieces in speaking order; a
 * piece with `col` set highlights that cell while it is spoken, `col: null` highlights the row's
 * first cell (or nothing, on an empty row).
 */
export function speakTableRow(header: string[], cells: string[]): RowPiece[] {
  // Column name before each value, so a row is followable by ear: "A, true; P(A), 0.3". Empty cells
  // are skipped; a column with no header text is read as its value alone.
  const pieces: RowPiece[] = [];
  cells.forEach((value, col) => {
    const v = value.trim();
    if (!v) return;
    const name = header[col]?.trim();
    pieces.push({ col, text: `${name ? `${name}, ` : ""}${v}` });
  });
  return pieces;
}

/** The prose of a quote's own blocks, nested quotes and list items included; code and tables skipped. */
function quoteText(blocks: MdBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "heading" || block.kind === "paragraph") return sentence(spanText(block.spans));
      if (block.kind === "quote") return quoteText(block.blocks);
      if (block.kind === "list") return block.items.map((item) => sentence(spanText(item))).join(" ");
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

/** End every spoken unit with a stop so the engine pauses between blocks, rows and items. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?:;]$/.test(t) ? t : `${t}.`;
}

/** Code this short is read aloud; longer code is announced. */
export const SPOKEN_CODE_LINES = 3;

export function buildCarScript(entry: TranscriptEntry): CarScript {
  const blocks = parseMarkdown(replyProse(entry));
  const segments: CarSegment[] = [];
  let text = "";

  /** Say `shown` (speakable spelling, stop added) and remember both spellings. */
  const sayShown = (shown: string, target: CarTarget) => {
    const t = shown.trim();
    if (!t) return;
    const { spoken, subs } = speakable(t);
    push(sentence(spoken), target, t, subs);
  };
  /** Say words that have no text of their own on screen (table rows, code). */
  const say = (piece: string, target: CarTarget) => {
    const t = piece.trim();
    if (t) push(speakable(t).spoken, target, "", []);
  };
  const push = (spoken: string, target: CarTarget, shown: string, subs: SpeechSub[]) => {
    if (text) text += " ";
    segments.push({ start: text.length, end: text.length + spoken.length, target, shown, subs });
    text += spoken;
  };

  blocks.forEach((block, b) => {
    switch (block.kind) {
      case "heading":
      case "paragraph":
        sayShown(spanText(block.spans), { block: b });
        return;
      case "quote":
        // A quote holds blocks of its own; it is said as one segment, so the whole quote is marked.
        sayShown(quoteText(block.blocks), { block: b });
        return;
      case "list":
        // One segment per item, so the highlight steps down the list item by item.
        block.items.forEach((item, row) => {
          const t = spanText(item);
          if (t) sayShown(t, { block: b, row, col: 0 });
        });
        return;
      case "code": {
        // Short code is read as written, a line at a time; longer code is announced and left to the
        // eye. A speakable-code layer would replace both.
        const lines = block.text.replace(/\n+$/, "").split("\n");
        const kind = `Code${block.lang ? ` in ${block.lang}` : ""}`;
        if (lines.length <= SPOKEN_CODE_LINES) say(`${kind}: ${lines.filter((l) => l.trim()).map((l) => sentence(l)).join(" ")}`, { block: b });
        else say(sentence(`${kind}, ${lines.length} lines`), { block: b });
        return;
      }
      case "table": {
        const header = block.header.map(spanText);
        block.rows.forEach((row, r) => {
          const pieces = speakTableRow(header, row.map(spanText));
          pieces.forEach((p, i) =>
            say(i === pieces.length - 1 ? sentence(p.text) : `${p.text};`, { block: b, row: r, col: p.col ?? 0 }),
          );
        });
        return;
      }
      case "rule":
        return;
    }
  });

  return { blocks, text, segments };
}

/** The segment holding character `offset`, or the last one before it (offsets in a gap). */
export function segmentAt(script: CarScript, offset: number): CarSegment | null {
  const segs = script.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let found: CarSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= offset) {
      found = segs[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
