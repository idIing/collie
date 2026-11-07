import { useCallback, useEffect, useRef, useState } from "react";

import { liveTranscribe } from "@/lib/api";
import { createSpeechEndpoint } from "@/lib/speech-endpoint";

// CAR MODE'S TALK: live words from the host's GPU engine (Parakeet in dictate-stt, behind the
// bridge's POST /api/stt/live), so they appear while they are spoken. The audio goes to the operator's
// own machine over the tailnet and nowhere else.
//
// The mic is tapped at 16 kHz (or resampled to it) and posted about half a second at a time; each
// step answers the words COMMITTED so far (two passes agreed) and the unconfirmed tail. Steps run one
// after another: audio that arrives while a step runs waits in the buffer and rides the next one.
//
// Silence is judged by Collie's own endpoint (lib/speech-endpoint.ts, the composer's 2 s), and only
// reported: whether quiet SENDS is the caller's choice (Car mode's Autoplay switch).

export type TalkPhase = "idle" | "starting" | "listening" | "finishing" | "error";

export interface CarTalk {
  phase: TalkPhase;
  /** Words the engine committed so far. */
  committed: string;
  /** The tail it is still unsure of. */
  pending: string;
  error: string | null;
  start: () => Promise<void>;
  /** Stop listening and resolve with the whole transcript (tail committed). */
  finish: () => Promise<string>;
  /** Stop and throw the words away. */
  cancel: () => void;
}

const STT_SAMPLE_RATE = 16_000;
/** Half a second per step: a GPU pass over the whole take costs tens of milliseconds. */
const STEP_SAMPLES = STT_SAMPLE_RATE / 2;
const TAP_FRAMES = 4096;

/** Linear resample to 16 kHz, for a browser that would not open a 16 kHz context. */
function to16k(input: Float32Array, rate: number): Float32Array {
  if (rate === STT_SAMPLE_RATE) return input.slice();
  const ratio = rate / STT_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
  }
  return out;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] ?? 0)) * 0x7fff;
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export function useCarTalk({ onSilence }: { onSilence: () => void }): CarTalk {
  const [phase, setPhase] = useState<TalkPhase>("idle");
  const [committed, setCommitted] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState<string | null>(null);

  const committedRef = useRef("");
  const run = useRef(0);
  const teardownRef = useRef<() => void>(() => {});
  const buffer = useRef<Int16Array[]>([]);
  const takeId = useRef("");
  const buffered = useRef(0);
  const stepping = useRef<Promise<void>>(Promise.resolve());
  const onSilenceRef = useRef(onSilence);
  onSilenceRef.current = onSilence;

  const take = (): Int16Array => {
    const out = new Int16Array(buffered.current);
    let at = 0;
    for (const part of buffer.current) {
      out.set(part, at);
      at += part.length;
    }
    buffer.current = [];
    buffered.current = 0;
    return out;
  };

  /** Queue one step; `end` finishes the take. Steps never overlap. */
  const step = useCallback((pcm: Int16Array, end: boolean, mine: number): Promise<void> => {
    const id = takeId.current;
    const runStep = async (): Promise<void> => {
      try {
        const out = await liveTranscribe(id, pcm, end);
        if (run.current !== mine) return;
        if ("text" in out) {
          committedRef.current = out.text;
          setCommitted(out.text);
          setPending("");
          return;
        }
        committedRef.current = out.committed;
        setCommitted(out.committed);
        setPending(out.pending);
      } catch {
        if (run.current !== mine) return;
        setError("Couldn't reach the speech engine on spectral. Is dictate-stt running?");
        setPhase("error");
      }
    };
    stepping.current = stepping.current.then(runStep, runStep);
    return stepping.current;
  }, []);

  const stopAudio = () => {
    teardownRef.current();
    teardownRef.current = () => {};
  };

  const start = useCallback(async () => {
    const mine = ++run.current;
    committedRef.current = "";
    setCommitted("");
    setPending("");
    setError(null);
    buffer.current = [];
    buffered.current = 0;
    setPhase("starting");
    takeId.current = crypto.randomUUID();
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (run.current !== mine) {
        for (const t of media.getTracks()) t.stop();
        return;
      }
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
      } catch {
        ctx = new AudioContext();
      }
      const source = ctx.createMediaStreamSource(media);
      // ScriptProcessor rather than an AudioWorklet: no extra module to serve under the CSP, and it
      // runs on every Safari car mode targets. The tap is one mono buffer every ~250 ms.
      const tap = ctx.createScriptProcessor(TAP_FRAMES, 1, 1);
      const endpoint = createSpeechEndpoint();
      let silenced = false;
      tap.onaudioprocess = (event) => {
        if (run.current !== mine) return;
        const raw = event.inputBuffer.getChannelData(0);
        const frame = endpoint.next(rms(raw), performance.now());
        const pcm = toInt16(to16k(raw, ctx.sampleRate));
        buffer.current.push(pcm);
        buffered.current += pcm.length;
        if (buffered.current >= STEP_SAMPLES) void step(take(), false, mine);
        if (frame.finish && !silenced) {
          silenced = true;
          onSilenceRef.current();
        }
      };
      source.connect(tap);
      // A processor only runs while connected to the output; it writes nothing, so nothing is heard.
      tap.connect(ctx.destination);
      teardownRef.current = () => {
        tap.onaudioprocess = null;
        source.disconnect();
        tap.disconnect();
        for (const t of media.getTracks()) t.stop();
        void ctx.close().catch(() => {});
      };
      setPhase("listening");
    } catch {
      if (run.current !== mine) return;
      setError("Microphone unavailable. Check the browser's permission for this site.");
      setPhase("error");
    }
  }, [step]);

  const finish = useCallback(async (): Promise<string> => {
    const mine = run.current;
    stopAudio();
    setPhase("finishing");
    await step(take(), true, mine);
    if (run.current !== mine) return "";
    setPending("");
    setPhase("idle");
    return committedRef.current.trim();
  }, [step]);

  const cancel = useCallback(() => {
    run.current++;
    stopAudio();
    buffer.current = [];
    buffered.current = 0;
    committedRef.current = "";
    setCommitted("");
    setPending("");
    setPhase("idle");
  }, []);

  useEffect(
    () => () => {
      run.current++;
      stopAudio();
    },
    [],
  );

  return { phase, committed, pending, error, start, finish, cancel };
}
