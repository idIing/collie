import { replyProse } from "./latest-reply";
import { parseMarkdown, type MdSpan } from "./markdown";
import type { TranscriptEntry } from "./types";

// Speech follows the transcript renderer's Markdown grammar instead of trying to clean source with
// a second pile of regular expressions. That keeps the phone saying the prose the operator sees:
// formatting delimiters and link targets disappear, while inline code keeps its useful words.
function spanText(spans: MdSpan[]): string {
  return spans
    .map((span) => (span.kind === "text" || span.kind === "code" ? span.text : spanText(span.spans)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Speakable chunks from one assistant turn.
 *
 * Fenced code, tables, and rules are visual material, not prose. Each remaining Markdown block is
 * its own utterance so mobile Safari does not have to hold one answer-sized utterance, and a list
 * keeps one item per chunk so its pauses survive after the bullets are removed.
 */
export function replySpeechChunks(entry: TranscriptEntry): string[] {
  const chunks: string[] = [];
  for (const block of parseMarkdown(replyProse(entry))) {
    if (block.kind === "code" || block.kind === "table" || block.kind === "rule") continue;
    if (block.kind === "list") {
      for (const item of block.items) {
        const text = spanText(item);
        if (text) chunks.push(text);
      }
      continue;
    }
    const text = spanText(block.spans);
    if (text) chunks.push(text);
  }
  return chunks;
}
