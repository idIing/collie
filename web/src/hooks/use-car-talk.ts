import { useCallback, useEffect, useRef, useState } from "react";

import { createSpeechEndpoint } from "@/lib/speech-endpoint";
import { STT_SAMPLE_RATE } from "@/lib/stt-engine";
import { phoneEngine } from "@/lib/stt";

// CAR MODE'S TALK: the phone's own engine (Whistle), fed live, so the words appear while they are
// spoken. Audio never leaves the phone.
//
// The mic is tapped at 16 kHz (or resampled to it) and handed to the engine about a second at a time;
// each step answers the words it COMMITTED (two passes agreed) and the unconfirmed tail. Steps run
// one after another: audio that arrives while a step runs waits in the buffer and rides the next one.
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

/** About one second per engine step, as the engine asks. */
const STEP_SAMPLES = STT_SAMPLE_RATE;
const TAP_FRAMES = 4096;

function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

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
  const buffer = useRef<Float32Array[]>([]);
  const buffered = useRef(0);
  const stepping = useRef<Promise<void>>(Promise.resolve());
  const onSilenceRef = useRef(onSilence);
  onSilenceRef.current = onSilence;

  const take = (): Float32Array => {
    const out = new Float32Array(buffered.current);
    let at = 0;
    for (const part of buffer.current) {
      out.set(part, at);
      at += part.length;
    }
    buffer.current = [];
    buffered.current = 0;
    return out;
  };

  /** Queue one engine step; `pcm` null ends the stream. Steps never overlap. */
  const step = useCallback((pcm: Float32Array | null, mine: number): Promise<void> => {
    const runStep = async (): Promise<void> => {
      const engine = await phoneEngine();
      const out = await engine.stream(pcm);
      if (run.current !== mine) return;
      if (!out.ok) {
        setError(out.code === "bytes-failed" ? "Whistle isn't on this phone yet: Settings → Voice → This phone." : `Speech engine: ${out.code}`);
        setPhase("error");
        return;
      }
      committedRef.current = join(committedRef.current, out.text);
      setCommitted(committedRef.current);
      setPending(out.pending);
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
    try {
      // A stale stream from an abandoned take is ended first, so this one starts empty.
      await step(null, -1);
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
        const pcm = to16k(raw, ctx.sampleRate);
        buffer.current.push(pcm);
        buffered.current += pcm.length;
        if (buffered.current >= STEP_SAMPLES) void step(take(), mine);
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
    if (buffered.current > 0) await step(take(), mine);
    await step(null, mine);
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
    void step(null, -1);
    committedRef.current = "";
    setCommitted("");
    setPending("");
    setPhase("idle");
  }, [step]);

  useEffect(
    () => () => {
      run.current++;
      stopAudio();
    },
    [],
  );

  return { phase, committed, pending, error, start, finish, cancel };
}
