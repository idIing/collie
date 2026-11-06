import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Pause, Play, RotateCcw, RotateCw, Send, X } from "lucide-react";

import { synthesizeSpeech } from "@/lib/api";
import { buildCarScript, segmentAt, spanText, type CarScript, type CarTarget } from "@/lib/car-script";
import { CAR_SPEEDS, SEEK_STEP_S, snapSeek, wordAt, type CarWord } from "@/lib/car-clock";
import { useCarTalk } from "@/hooks/use-car-talk";
import type { TranscriptEntry } from "@/lib/types";

// CAR MODE: one pane, one reply, read aloud by the bridge's local engine.
//
// Everything on screen reads one clock, the audio element's currentTime: the timeline, the word in
// bold, the cell outlined. Seeks snap to a word start so playback never resumes mid-word.
//
// The current word is marked by WEIGHT and an UNDERLINE, a cell by a heavy OUTLINE — never by hue
// alone (the operator this was built for is colourblind).

interface CarViewProps {
  /** Shown big at the top, so a glance says whose answer this is. */
  paneLabel: string;
  /** Per-pane address, the key the Autoplay switch is remembered under. */
  paneKey: string;
  reply: TranscriptEntry | null;
  onExit: () => void;
  /**
   * Send spoken words to this pane down the composer's guarded path. False means they went into the
   * draft instead (lib: ComposerHandle.sendSpoken). Absent: no Talk button.
   */
  onSend?: (text: string) => Promise<boolean>;
}

interface Render {
  uuid: string;
  script: CarScript;
  words: CarWord[];
  url: string;
}

/** A silent WAV, as a blob URL (the CSP admits blob: media, not data:): the first tap's unlock clip. */
let silence: string | null = null;
function silenceUrl(): string {
  silence ??= URL.createObjectURL(
    new Blob([Uint8Array.from(atob("UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA"), (c) => c.charCodeAt(0))], { type: "audio/wav" }),
  );
  return silence;
}

const autoplayKey = (paneKey: string) => `collie:car-autoplay:v1:${paneKey}`;

function readAutoplay(paneKey: string): boolean {
  try {
    return globalThis.localStorage?.getItem(autoplayKey(paneKey)) === "1";
  } catch {
    return false;
  }
}

function fmt(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function CarView({ paneLabel, paneKey, reply, onExit, onSend }: CarViewProps) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [autoplay, setAutoplay] = useState(() => readAutoplay(paneKey));
  const unlocked = useRef(false);

  const ready = reply !== null && !reply.partial;

  // ── Talk: live words on the phone's engine; Send sends, or quiet does when Autoplay is on ─────
  const [talkNote, setTalkNote] = useState<string | null>(null);
  const sendTalk = useRef<() => Promise<void>>(async () => {});
  const talk = useCarTalk({ onSilence: () => { if (autoplayRef.current) void sendTalk.current(); } });
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  sendTalk.current = async () => {
    const words = await talk.finish();
    if (!words) {
      setTalkNote("Didn't catch anything.");
      return;
    }
    const sent = (await onSend?.(words)) ?? false;
    setTalkNote(sent ? `Sent: ${words}` : "Not sent: the pane couldn't take it, so it's in the message box.");
  };
  const startTalk = useCallback(() => {
    audio.current?.pause();
    setTalkNote(null);
    void talk.start();
  }, [talk]);
  const talking = talk.phase === "starting" || talk.phase === "listening" || talk.phase === "finishing";

  // ── Render: one request per reply, cached by uuid ───────────────────────
  const ensureRender = useCallback(async (): Promise<Render | null> => {
    if (!reply || reply.partial) return null;
    if (render?.uuid === reply.uuid) return render;
    setLoading(true);
    setError(null);
    try {
      const script = buildCarScript(reply);
      const out = await synthesizeSpeech(script.text);
      const next = { uuid: reply.uuid, script, words: out.words, url: URL.createObjectURL(out.audio) };
      setRender((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return next;
      });
      return next;
    } catch {
      setError("Couldn't render this reply. Is the speech engine running?");
      return null;
    } finally {
      setLoading(false);
    }
  }, [reply, render]);

  const playRender = useCallback(
    async (r: Render) => {
      const el = audio.current;
      if (!el) return;
      if (el.src !== r.url) {
        el.src = r.url;
        el.currentTime = 0;
      }
      el.playbackRate = speed;
      await el.play().catch(() => {
        setError("Tap Play to start (the browser blocked playback).");
      });
    },
    [speed],
  );

  const togglePlay = useCallback(async () => {
    const el = audio.current;
    if (el && playing) {
      el.pause();
      return;
    }
    // iOS counts a tap as permission to play only while the tap's own task runs, and the render
    // below is a network round trip. So the FIRST tap plays a silent clip right here, which unlocks
    // this element for every later play() — the render, and autoplay of later replies.
    if (el && !unlocked.current) {
      unlocked.current = true;
      el.src = silenceUrl();
      void el.play().then(() => el.pause()).catch(() => {});
    }
    const r = await ensureRender();
    if (r) await playRender(r);
  }, [ensureRender, playRender, playing]);

  const seekTo = useCallback(
    (t: number) => {
      const el = audio.current;
      if (!el || !render) return;
      el.currentTime = snapSeek(render.words, t, el.duration || duration);
      setNow(el.currentTime);
    },
    [render, duration],
  );
  const back = useCallback(() => seekTo((audio.current?.currentTime ?? 0) - SEEK_STEP_S), [seekTo]);
  const fwd = useCallback(() => seekTo((audio.current?.currentTime ?? 0) + SEEK_STEP_S), [seekTo]);

  // ── Autoplay: only when switched on for THIS pane, and only once the reply is whole ─────
  const lastAuto = useRef<string | null>(reply?.uuid ?? null);
  useEffect(() => {
    if (!autoplay || !ready || !reply || lastAuto.current === reply.uuid) return;
    lastAuto.current = reply.uuid;
    void ensureRender().then((r) => r && playRender(r));
  }, [autoplay, ready, reply, ensureRender, playRender]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(autoplayKey(paneKey), autoplay ? "1" : "0");
    } catch {
      /* a private window keeps the switch for this visit only */
    }
  }, [autoplay, paneKey]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  // ── The clock: rAF while playing, so the bold word keeps up with fast speech ─────
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      setNow(audio.current?.currentTime ?? 0);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  // ── Screen stays awake while car mode is open ─────────────────────────────
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, []);

  // ── Steering-wheel and lock-screen buttons (Media Session) ────────────────
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.metadata = new MediaMetadata({ title: paneLabel, artist: "Collie car mode" });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void togglePlay()],
      ["pause", () => audio.current?.pause()],
      ["seekbackward", back],
      ["seekforward", fwd],
      ["previoustrack", back],
      ["nexttrack", fwd],
    ];
    for (const [a, h] of handlers) {
      try {
        ms.setActionHandler(a, h);
      } catch {
        /* an action this browser does not know */
      }
    }
    return () => {
      for (const [a] of handlers) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* as above */
        }
      }
    };
  }, [paneLabel, togglePlay, back, fwd]);

  useEffect(() => () => {
    if (render) URL.revokeObjectURL(render.url);
  }, [render]);

  // ── What to mark ──────────────────────────────────────────────────────────
  const active = useMemo(() => {
    if (!render) return null;
    const i = wordAt(render.words, now);
    if (i < 0) return null;
    const word = render.words[i];
    const seg = segmentAt(render.script, word.offset);
    return seg ? { word, seg } : null;
  }, [render, now]);

  const replyIsNewer = reply && render && reply.uuid !== render.uuid;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground" role="region" aria-label="Car mode">
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the captions ARE this view: the word on screen, live. */}
      <audio
        ref={audio}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />

      <header className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2">
        <div className="min-w-0 flex-1 truncate text-xl font-semibold">{paneLabel}</div>
        <label className="flex items-center gap-2 text-base font-medium">
          <input
            type="checkbox"
            className="size-6"
            checked={autoplay}
            onChange={(e) => setAutoplay(e.currentTarget.checked)}
          />
          Autoplay {autoplay ? "on" : "off"}
        </label>
        <button type="button" onClick={onExit} className="rounded-lg p-3" aria-label="Exit car mode">
          <X className="size-7" />
        </button>
      </header>

      <main className="flex min-h-0 flex-1 items-center overflow-hidden px-4" aria-live="off">
        {talking || talk.phase === "error" ? (
          <p className="text-4xl leading-snug font-semibold">
            {talk.phase === "error" ? (
              talk.error
            ) : talk.committed || talk.pending ? (
              <>
                {talk.committed} <span className="opacity-55 italic">{talk.pending}</span>
              </>
            ) : (
              <span className="opacity-55">{talk.phase === "starting" ? "Starting the mic…" : "Listening…"}</span>
            )}
          </p>
        ) : talkNote ? (
          <p className="text-3xl leading-snug font-semibold">{talkNote}</p>
        ) : error ? (
          <p className="text-2xl font-semibold">{error}</p>
        ) : !reply ? (
          <p className="text-2xl text-muted-foreground">No reply in this pane yet.</p>
        ) : !render ? (
          <p className="text-2xl text-muted-foreground">
            {loading ? "Rendering…" : reply.partial ? "The agent is still writing…" : "Tap Play to hear the latest reply."}
          </p>
        ) : (
          <Caption script={render.script} active={active} />
        )}
      </main>

      {replyIsNewer && !autoplay && (
        <p className="px-4 pb-1 text-base font-semibold">● New reply. Tap Play for the newest.</p>
      )}

      {talking && (
        <footer className="flex gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => talk.cancel()}
            className="h-24 flex-1 rounded-2xl border-4 border-foreground text-2xl font-bold"
          >
            <X className="mr-2 inline size-8" />
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void sendTalk.current()}
            disabled={talk.phase !== "listening"}
            className="h-24 flex-[2] rounded-2xl bg-foreground text-2xl font-black text-background disabled:opacity-40"
          >
            <Send className="mr-2 inline size-8" />
            {autoplay ? "Send (or pause 2s)" : "Send"}
          </button>
        </footer>
      )}

      <footer className={`px-4 pb-[max(1rem,env(safe-area-inset-bottom))] ${talking ? "hidden" : ""}`}>
        {onSend && (
          <button
            type="button"
            onClick={startTalk}
            className="mb-3 flex h-20 w-full items-center justify-center gap-3 rounded-2xl border-4 border-foreground text-2xl font-black"
          >
            <Mic className="size-9" />
            Talk
          </button>
        )}
        <input
          type="range"
          aria-label="Timeline"
          className="h-10 w-full"
          min={0}
          max={duration || 0}
          step={0.1}
          value={now}
          disabled={!render}
          onChange={(e) => seekTo(Number(e.currentTarget.value))}
        />
        <div className="flex justify-between text-base tabular-nums">
          <span>{fmt(now)}</span>
          <span>{fmt(duration)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <button type="button" onClick={back} disabled={!render} className="flex flex-col items-center rounded-2xl p-4 disabled:opacity-40" aria-label="Back 5 seconds">
            <RotateCcw className="size-12" />
            <span className="text-sm font-semibold">5s</span>
          </button>
          <button
            type="button"
            onClick={() => void togglePlay()}
            disabled={!ready || loading}
            className="flex size-28 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="size-14" /> : <Play className="size-14" />}
          </button>
          <button type="button" onClick={fwd} disabled={!render} className="flex flex-col items-center rounded-2xl p-4 disabled:opacity-40" aria-label="Forward 5 seconds">
            <RotateCw className="size-12" />
            <span className="text-sm font-semibold">5s</span>
          </button>
        </div>
        <div className="mt-3 flex justify-center gap-2" role="group" aria-label="Speed">
          {CAR_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`rounded-lg border-2 px-3 py-2 text-base ${speed === s ? "border-foreground font-black underline" : "border-transparent"}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

function Caption({
  script,
  active,
}: {
  script: CarScript;
  active: { word: CarWord; seg: { start: number; end: number; target: CarTarget } } | null;
}) {
  if (!active) return <p className="text-3xl text-muted-foreground">Ready.</p>;
  const { word, seg } = active;
  const block = script.blocks[seg.target.block];

  if (block?.kind === "table" && "row" in seg.target) {
    const { row, col } = seg.target;
    return (
      <table className="w-full table-fixed border-collapse text-2xl">
        <thead>
          <tr>
            {block.header.map((h, c) => (
              <th key={c} className="border-b-2 border-foreground p-2 text-left">{spanText(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((cells, r) => (
            <tr key={r} className={r === row ? "font-semibold" : "text-muted-foreground"}>
              {cells.map((cell, c) => (
                <td key={c} className={`p-2 ${r === row && c === col ? "font-black outline outline-4 -outline-offset-4 outline-foreground" : ""}`}>
                  {spanText(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (block?.kind === "code") {
    return (
      <pre className="max-h-full w-full overflow-hidden whitespace-pre-wrap rounded-lg border-4 border-foreground p-3 font-mono text-lg">
        {block.text}
      </pre>
    );
  }

  // Prose: one PAGE of the spoken segment, the current word heavy, full-bright and underlined, the
  // rest dimmed. Paging (rather than scrolling per word) keeps the line still for a glance.
  const text = script.text;
  const wStart = Math.max(seg.start, word.offset);
  const wEnd = Math.min(seg.end, word.offset + word.length);
  const [from, to] = captionPage(text, seg.start, seg.end, wStart);
  return (
    <p className="text-4xl leading-snug font-normal">
      <span className="opacity-55">{text.slice(from, wStart)}</span>
      <span className="font-black underline decoration-4 underline-offset-8">{text.slice(wStart, wEnd)}</span>
      <span className="opacity-55">{text.slice(wEnd, to)}</span>
    </p>
  );
}

/** Words per caption page: what fits at text-4xl on a phone in portrait. */
const PAGE_WORDS = 16;

/** The `[from, to)` page of `[start, end)` holding offset `at`, cut on word boundaries. */
function captionPage(text: string, start: number, end: number, at: number): [number, number] {
  const starts: number[] = [];
  for (const m of text.slice(start, end).matchAll(/\S+/g)) starts.push(start + m.index);
  let i = starts.findLastIndex((s) => s <= at);
  if (i < 0) i = 0;
  const first = Math.floor(i / PAGE_WORDS) * PAGE_WORDS;
  return [starts[first] ?? start, starts[first + PAGE_WORDS] ?? end];
}
