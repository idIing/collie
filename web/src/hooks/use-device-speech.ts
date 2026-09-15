import { useCallback, useEffect, useRef, useState } from "react";

import { deviceSpeechCapability } from "@/lib/env";

interface UseDeviceSpeechResult {
  supported: boolean;
  speaking: boolean;
  speak: (chunks: string[]) => void;
  stop: () => void;
}

/** A tiny queue over the browser's own voices. No audio or answer text leaves the phone. */
export function useDeviceSpeech(lang: string): UseDeviceSpeechResult {
  const supported = deviceSpeechCapability() !== null;
  const [speaking, setSpeaking] = useState(false);
  // Invalidating a run before cancel means a late `end`/`error` from that run cannot start its next
  // chunk. WebKit does not promise which event cancel emits, so correctness cannot depend on one.
  const run = useRef(0);

  const stop = useCallback(() => {
    run.current += 1;
    deviceSpeechCapability()?.synthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (rawChunks: string[]) => {
      const deviceSpeech = deviceSpeechCapability();
      if (!deviceSpeech) return;
      const chunks = rawChunks.map((chunk) => chunk.trim()).filter(Boolean);
      if (chunks.length === 0) return;

      deviceSpeech.synthesis.cancel();
      const currentRun = ++run.current;
      let index = 0;
      setSpeaking(true);

      const next = () => {
        if (run.current !== currentRun) return;
        const text = chunks[index++];
        if (text === undefined) {
          setSpeaking(false);
          return;
        }
        const utterance = new deviceSpeech.Utterance(text);
        utterance.lang = lang;
        utterance.addEventListener("end", next, { once: true });
        utterance.addEventListener("error", () => {
          if (run.current === currentRun) setSpeaking(false);
        }, { once: true });
        deviceSpeech.synthesis.speak(utterance);
      };
      next();
    },
    [lang],
  );

  useEffect(() => stop, [stop]);

  return { supported, speaking, speak, stop };
}
