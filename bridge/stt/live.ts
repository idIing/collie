// Car mode's LIVE speech-to-text, against a local engine (Parakeet in the operator's dictate-stt
// box, `POST /v1/transcribe`, loopback only). Experimental and env-configured
// (COLLIE_STT_LIVE_URL) until it earns a place in the provider seam beside bridge/stt/.
//
// The phone posts its take in pieces (16 kHz mono int16 LE, about half a second each). The bridge
// keeps the take's audio and re-transcribes all of it per piece, which a GPU engine does in tens of
// milliseconds; a word is COMMITTED once two consecutive passes agree on it, and the rest is the
// pending tail. Ending the take answers one last pass over everything.

import type { JsonValue } from "../json.ts";

export const LIVE_SAMPLE_RATE = 16_000;
/** A take longer than this is refused, as the engine refuses it. */
export const LIVE_MAX_SECONDS = 120;
/** A take nobody has fed for this long is dropped. */
const TAKE_IDLE_MS = 60_000;

export interface LiveStep {
  committed: string;
  pending: string;
}

interface Take {
  chunks: Uint8Array[];
  bytes: number;
  previous: string[];
  touched: number;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const fold = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The words two passes agree on, from the start; the last pass's remainder is pending. */
export function agree(previous: readonly string[], current: readonly string[]): LiveStep {
  let n = 0;
  while (n < previous.length && n < current.length && fold(previous[n] ?? "") === fold(current[n] ?? "")) n++;
  return { committed: current.slice(0, n).join(" "), pending: current.slice(n).join(" ") };
}

function asText(raw: JsonValue | undefined): string | null {
  if (raw === null || raw === undefined || Array.isArray(raw) || !(raw instanceof Object)) return null;
  const text = raw.text;
  // SAFETY: `[object String]` from the primitive tag means the value IS a string.
  return Object.prototype.toString.call(text) === "[object String]" ? (text as string) : null;
}

export interface LiveStt {
  /** Add `pcm` to take `id` and answer the current reading; with `end`, the final text, and the take is gone. */
  step: (id: string, pcm: Uint8Array, end: boolean) => Promise<LiveStep | { text: string }>;
}

/** The one request this module makes: what a test fake has to answer. */
export type LiveFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Uint8Array<ArrayBuffer>; signal: AbortSignal },
) => Promise<Response>;

export function createLiveStt(opts: { baseUrl: string; fetchImpl?: LiveFetch; now?: () => number }): LiveStt {
  const takes = new Map<string, Take>();
  const now = opts.now ?? Date.now;

  const sweep = () => {
    const t = now();
    for (const [id, take] of takes) if (t - take.touched > TAKE_IDLE_MS) takes.delete(id);
  };

  const pass = async (take: Take): Promise<string> => {
    const body = new Uint8Array(take.bytes);
    let at = 0;
    for (const c of take.chunks) {
      body.set(c, at);
      at += c.length;
    }
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/v1/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`live stt ${res.status}`);
    let raw: JsonValue | undefined;
    try {
      // SAFETY: `JSON.parse` answers with a JSON value by construction; `asText` checks the one field.
      raw = JSON.parse(await res.text()) as JsonValue;
    } catch {
      raw = undefined;
    }
    const text = asText(raw);
    if (text === null) throw new Error("live stt: unexpected response");
    return text.trim();
  };

  return {
    async step(id, pcm, end) {
      sweep();
      const take = takes.get(id) ?? { chunks: [], bytes: 0, previous: [], touched: now() };
      takes.set(id, take);
      take.touched = now();
      if (take.bytes + pcm.length > LIVE_MAX_SECONDS * LIVE_SAMPLE_RATE * 2) {
        takes.delete(id);
        throw new Error("live stt: take too long");
      }
      if (pcm.length > 0) {
        take.chunks.push(pcm);
        take.bytes += pcm.length;
      }
      if (end) {
        takes.delete(id);
        return { text: take.bytes > 0 ? await pass(take) : "" };
      }
      const current = words(await pass(take));
      const step = agree(take.previous, current);
      take.previous = current;
      return step;
    },
  };
}
