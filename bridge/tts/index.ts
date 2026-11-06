import { readFile } from "node:fs/promises";

import type { JsonValue } from "../json.ts";
import { asString, type Lexicon } from "./kokoro.ts";

export { asString as asTtsString, synthesize as synthesizeTts } from "./kokoro.ts";
export type { Lexicon, TtsResult, TtsWord } from "./kokoro.ts";

/**
 * The operator's pronunciation lexicon, `{ "term": "ipa" }`, from the state dir. Missing or
 * malformed reads as empty: a bad lexicon costs pronunciations, never the reading.
 */
export async function readTtsLexicon(path: string): Promise<Lexicon> {
  try {
    // SAFETY: `JSON.parse` answers with a JSON value by construction; every field is checked below.
    const raw = JSON.parse(await readFile(path, "utf8")) as JsonValue;
    if (raw === null || Array.isArray(raw) || !(raw instanceof Object)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const ipa = asString(v);
      if (ipa !== undefined && k.trim()) out[k] = ipa;
    }
    return out;
  } catch {
    return {};
  }
}
