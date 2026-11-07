// What car mode SAYS for a piece of text it SHOWS, and how to get from one back to the other.
//
// The screen keeps the text as written; the voice gets a shorter, speakable spelling of the parts
// that read badly aloud (a long file path is the one today). Each substitution is remembered, so a
// word the engine is saying maps back to the characters on screen: a word inside a substitution marks
// the whole original, a word outside it shifts by the length the substitutions before it changed.

/** One substitution, as `[start, end)` offsets in the spoken text and in the shown text. */
export interface SpeechSub {
  s0: number;
  s1: number;
  d0: number;
  d1: number;
}

export interface Speakable {
  spoken: string;
  subs: SpeechSub[];
}

/**
 * A path-like token: no spaces, at least two slashes between non-empty parts, not a URL.
 * `/home/idle/projects/balatro/alpha-balatro`, `~/boxes/bin/projbox`, `web/src/lib/x.ts`.
 */
const PATH = /(?<![\w.@+~:/-])(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/){2,}[\w.@+-]*\/?/g;

/** How a path is said: its deepest two parts, the way you would name it out loud. */
export function speakPath(path: string): string {
  const parts = path.split("/").filter((p) => p !== "" && p !== "~" && p !== "." && p !== "..");
  return parts.slice(-2).join("/");
}

export function speakable(shown: string): Speakable {
  const subs: SpeechSub[] = [];
  let spoken = "";
  let at = 0;
  for (const m of shown.matchAll(PATH)) {
    const d0 = m.index;
    const d1 = d0 + m[0].length;
    const said = speakPath(m[0]);
    if (said === m[0]) continue;
    spoken += shown.slice(at, d0);
    subs.push({ s0: spoken.length, s1: spoken.length + said.length, d0, d1 });
    spoken += said;
    at = d1;
  }
  spoken += shown.slice(at);
  return { spoken, subs };
}

/** The shown range for spoken `[s, e)`; clipped to `shownLength` (a spoken stop past the end marks nothing). */
export function shownRange(subs: readonly SpeechSub[], s: number, e: number, shownLength: number): [number, number] {
  let delta = 0;
  for (const sub of subs) {
    if (s >= sub.s1) {
      delta += sub.d1 - sub.d0 - (sub.s1 - sub.s0);
      continue;
    }
    if (s >= sub.s0) return [sub.d0, sub.d1];
    break;
  }
  const from = Math.min(s + delta, shownLength);
  return [from, Math.min(Math.max(from, e + delta), shownLength)];
}
