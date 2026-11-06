// The one clock car mode reads: the audio element's currentTime, against the engine's word timings.

/** A word the engine spoke: seconds into the audio, and where it sits in the car script's text. */
export interface CarWord {
  start: number;
  end: number;
  /** Character offset into CarScript.text, as the bridge aligned it. */
  offset: number;
  length: number;
}

/** Index of the word being spoken at `t` (the last word that has started), or −1 before the first. */
export function wordAt(words: readonly CarWord[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Where a seek to `t` actually lands: the start of the word in progress at `t`, so playback never
 * resumes mid-word. Clamped to the audio. With no timings (yet), the raw time.
 */
export function snapSeek(words: readonly CarWord[], t: number, duration: number): number {
  const clamped = Math.max(0, Math.min(t, duration));
  const i = wordAt(words, clamped);
  return i < 0 ? 0 : words[i].start;
}

export const SEEK_STEP_S = 5;
export const CAR_SPEEDS = [0.75, 0.9, 1, 1.25, 1.5] as const;
