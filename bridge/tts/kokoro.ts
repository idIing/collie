// Text-to-speech for car mode, against a LOCAL Kokoro-FastAPI (workloads/kokoro-tts in the
// operator's boxes; loopback only). One request per reply: the whole car script in, one audio file
// and its word timings out, so the phone has a single clock to seek and scrub on.
//
// Experimental and env-configured (COLLIE_TTS_URL) until it earns a provider seam like bridge/stt/.

import type { JsonValue } from "../json.ts";

export interface TtsWord {
  start: number;
  end: number;
  /** Character offset into the text the phone sent. */
  offset: number;
  length: number;
}

export interface TtsResult {
  audio: Uint8Array;
  mime: string;
  words: TtsWord[];
}

/** term → IPA. Private to the operator (never in this repo): it is learned from their replies. */
export type Lexicon = Readonly<Record<string, string>>;

interface KokoroTimestamp {
  word: string;
  start_time: number;
  end_time: number;
}

/** A string, or undefined. The primitive tag cannot be spoofed by a parsed document. */
export function asString(value: JsonValue | undefined): string | undefined {
  // SAFETY: `[object String]` from Object.prototype.toString means the value IS a string; JSON.parse
  // produces string keys only, so Symbol.toStringTag cannot forge it.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Number]") return undefined;
  // SAFETY: as in `asString`, the tag just reported a number.
  const n = value as number;
  return Number.isFinite(n) ? n : undefined;
}

/** Kokoro's captioned-speech body, checked field by field. Null when it is not that shape. */
export function parseCaptioned(raw: JsonValue | undefined): { audio: string; timestamps: KokoroTimestamp[] } | null {
  if (raw === null || raw === undefined || Array.isArray(raw) || !(raw instanceof Object)) return null;
  const audio = asString(raw.audio);
  if (audio === undefined) return null;
  const timestamps: KokoroTimestamp[] = [];
  const list = raw.timestamps;
  for (const t of Array.isArray(list) ? list : []) {
    if (t === null || Array.isArray(t) || !(t instanceof Object)) continue;
    const word = asString(t.word);
    const start = asNumber(t.start_time);
    const end = asNumber(t.end_time);
    if (word !== undefined && start !== undefined && end !== undefined) timestamps.push({ word, start_time: start, end_time: end });
  }
  return { audio, timestamps };
}

const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

interface Token {
  offset: number;
  length: number;
  folded: string;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const folded = fold(m[0]);
    if (folded) out.push({ offset: m.index, length: m[0].length, folded });
  }
  return out;
}

/** How far ahead a spoken word may match a written one before we call it an expansion. */
const LOOKAHEAD = 6;

/**
 * Map the engine's words onto the text we sent. Words match written tokens in order; a spoken word
 * the text never wrote ("forty two" for "42") attaches to the unread token holding a digit or
 * symbol, or else to the token before it, so its time still lands on the right thing on screen.
 */
export function alignWords(text: string, spoken: readonly KokoroTimestamp[]): TtsWord[] {
  const written = tokens(text);
  const out: TtsWord[] = [];
  let cursor = 0;
  for (const w of spoken) {
    const f = fold(w.word);
    if (!f) continue;
    let hit = -1;
    for (let j = cursor; j < Math.min(written.length, cursor + LOOKAHEAD); j++) {
      const t = written[j]?.folded;
      if (t !== undefined && (t.startsWith(f) || f.startsWith(t))) {
        hit = j;
        break;
      }
    }
    if (hit >= 0) cursor = hit + 1;
    // No match: a normalizer expanded something. Digits and symbols ("42", "a.ts", "--dry-run") are
    // what it expands, so an unread token holding one owns the word; otherwise the token before it.
    const next = written[cursor];
    const owner = hit >= 0 ? hit : next && /[^\p{L}\s]/u.test(text.slice(next.offset, next.offset + next.length)) ? cursor : Math.max(0, cursor - 1);
    const tok = written[owner];
    if (!tok) continue;
    // An expansion re-uses the previous token: extend that word's end instead of adding a duplicate.
    const prev = out[out.length - 1];
    if (prev && prev.offset === tok.offset) {
      prev.end = w.end_time;
      continue;
    }
    out.push({ start: w.start_time, end: w.end_time, offset: tok.offset, length: tok.length });
  }
  return out;
}

/** Inline IPA overrides, Kokoro's own `[word](/ipa/)` markup, applied to whole words only. */
export function applyLexicon(text: string, lexicon: Lexicon): string {
  const terms = Object.keys(lexicon).toSorted((a, b) => b.length - a.length);
  if (terms.length === 0) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return text.replace(re, (term) => `[${term}](/${lexicon[term]}/)`);
}

export async function synthesize(opts: {
  baseUrl: string;
  text: string;
  voice: string;
  lexicon: Lexicon;
  fetchImpl?: typeof fetch;
}): Promise<TtsResult> {
  const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/dev/captioned_speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "kokoro",
      input: applyLexicon(opts.text, opts.lexicon),
      voice: opts.voice,
      response_format: "mp3",
      stream: false,
      return_timestamps: true,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`kokoro ${res.status}`);
  let raw: JsonValue | undefined;
  try {
    // SAFETY: `JSON.parse` answers with a JSON value by construction; `parseCaptioned` checks it.
    raw = JSON.parse(await res.text()) as JsonValue;
  } catch {
    raw = undefined;
  }
  const body = parseCaptioned(raw);
  if (!body) throw new Error("kokoro: unexpected response shape");
  return {
    audio: Uint8Array.from(Buffer.from(body.audio, "base64")),
    mime: "audio/mpeg",
    words: alignWords(opts.text, body.timestamps),
  };
}
