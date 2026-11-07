import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Mic, Pause, Play, RotateCcw, RotateCw, Send, SkipBack, SkipForward, X } from "lucide-react";

import { synthesizeSpeech } from "@/lib/api";
import { buildCarScript, type CarScript } from "@/lib/car-script";
import { CAR_SPEEDS, SEEK_STEP_S, snapSeek, wordAt, type CarWord } from "@/lib/car-clock";
import { carFeed, feedReplies } from "@/lib/car-feed";
import { nextLineup } from "@/lib/car-lineup";
import { carSession } from "@/lib/car-session";
import { carStatusLine } from "@/lib/car-status";
import { paneRowKey } from "@/lib/hosts";
import { paneName } from "@/lib/pane-name";
import type { Scope } from "@/lib/scope";
import { shownStatus } from "@/lib/triage";
import { useCarTalk } from "@/hooks/use-car-talk";
import { useCarFeedData } from "@/hooks/use-car-feed";
import { CarDocument, type CarActive } from "@/components/car-document";
import { StatusDot } from "@/components/status-badge";
import type { AgentStatus, AgentView, TranscriptEntry } from "@/lib/types";

// CAR MODE: a podcast of the pane's replies that you can talk back to, read aloud by the bridge's
// local engine.
//
// The screen is one document (car-document.tsx): the final replies, your turns between them. Play
// reads the newest; "Play from here" reads any older one and carries on into the newer ones; ⏮ ⏭
// step a whole reply (⏮ restarts the current one first, past 3 s). Swiping sideways moves to the next
// agent with something going on (lib/car-lineup.ts); car mode, Autoplay and speed come along
// (lib/car-session.ts), playback does not.
//
// Everything on screen reads one clock, the audio element's currentTime. Seeks snap to a word start.
// The current word is marked by WEIGHT and an UNDERLINE, a cell by a heavy OUTLINE — never by hue
// alone (the operator this was built for is colourblind).

interface CarViewProps {
  paneId: string;
  scope?: Scope;
  /** Shown big at the top, so a glance says whose answer this is. */
  paneLabel: string;
  /** This pane's row key (lib/hosts.ts), its place in the swipe. */
  here: string;
  /** The newest reply the pane view holds: what Autoplay starts on. */
  reply: TranscriptEntry | null;
  /** Herdr's status for the pane: whether the latest reply is final or a progress note. */
  status: AgentStatus;
  /** Every agent on the herd, for the swipe. */
  agents: AgentView[];
  /** Open another agent in car mode. */
  onSwitch: (pane: AgentView) => void;
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

/** ⏮ past this many seconds into a reply restarts it; earlier, it goes to the reply before. */
const RESTART_AFTER_S = 3;
/** Rendered replies kept, so stepping back and forth does not re-render. */
const RENDERS_KEPT = 8;
const SCALE_KEY = "collie:car-text-scale:v1";
const SCALE_MIN = 0.6;
const SCALE_MAX = 2.2;
/** A sideways swipe: this far, mostly sideways, this fast. */
const SWIPE_PX = 70;
const SWIPE_MS = 700;

/** A silent WAV, as a blob URL (the CSP admits blob: media, not data:): the first tap's unlock clip. */
let silence: string | null = null;
function silenceUrl(): string {
  silence ??= URL.createObjectURL(
    new Blob([Uint8Array.from(atob("UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA"), (c) => c.charCodeAt(0))], { type: "audio/wav" }),
  );
  return silence;
}

function readScale(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(SCALE_KEY));
    return Number.isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX ? v : 1;
  } catch {
    return 1;
  }
}

/** The distance between two fingers, for the pinch. */
function spread(e: React.TouchEvent): number {
  const a = e.touches[0];
  const b = e.touches[1];
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
}

function fmt(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function CarView({ paneId, scope, paneLabel, here, reply, status, agents, onSwitch, onExit, onSend }: CarViewProps) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Render | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<number>(carSession.speed);
  const [autoplay, setAutoplay] = useState(carSession.autoplay);
  const [scale, setScale] = useState(readScale);
  const unlocked = useRef(false);

  useEffect(() => {
    carSession.autoplay = autoplay;
    carSession.speed = speed;
  }, [autoplay, speed]);

  // ── The document: final replies + your turns, and the newest reply even before the log has it ──
  const data = useCarFeedData({ paneId, scope, trigger: `${reply?.uuid ?? ""}|${reply?.partial === true}|${status}` });
  const feed = useMemo(() => {
    const items = carFeed(data.entries, status);
    if (reply && !reply.partial && !items.some((i) => i.entry.uuid === reply.uuid)) {
      items.push({ kind: "reply", entry: reply, progress: status === "working" });
    }
    return items;
  }, [data.entries, status, reply]);
  const replies = useMemo(() => feedReplies(feed), [feed]);

  // One script per reply, kept by id: the document draws from the same object the audio was cut to.
  const scriptCache = useRef(new Map<string, CarScript>());
  const scriptOf = useCallback(
    (uuid: string): CarScript => {
      const hit = scriptCache.current.get(uuid);
      if (hit) return hit;
      const entry = replies.find((r) => r.uuid === uuid);
      const script = buildCarScript(entry ?? { uuid, ts: "", role: "assistant", parts: [] });
      if (entry) scriptCache.current.set(uuid, script);
      return script;
    },
    [replies],
  );

  // ── Rendering audio: one request per reply, a few kept ─────────────────────
  const renders = useRef(new Map<string, Promise<Render>>());
  const renderOf = useCallback(
    (entry: TranscriptEntry): Promise<Render> => {
      const hit = renders.current.get(entry.uuid);
      if (hit) return hit;
      const script = scriptOf(entry.uuid);
      const job = synthesizeSpeech(script.text).then((out) => ({
        uuid: entry.uuid,
        script,
        words: out.words,
        url: URL.createObjectURL(out.audio),
      }));
      job.catch(() => renders.current.delete(entry.uuid));
      renders.current.set(entry.uuid, job);
      // Evict the oldest beyond the budget (Map keeps insertion order).
      while (renders.current.size > RENDERS_KEPT) {
        const [oldest, p] = renders.current.entries().next().value ?? [];
        if (oldest === undefined || p === undefined) break;
        renders.current.delete(oldest);
        void p.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
      }
      return job;
    },
    [scriptOf],
  );
  useEffect(
    () => () => {
      for (const p of renders.current.values()) void p.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
    },
    [],
  );

  /** Load reply `entry` and play it from the start (or from `at`). */
  const playEntry = useCallback(
    async (entry: TranscriptEntry, at = 0) => {
      const el = audio.current;
      if (!el) return;
      setLoading(true);
      setError(null);
      try {
        const r = await renderOf(entry);
        setCurrent(r);
        if (el.src !== r.url) el.src = r.url;
        el.currentTime = at;
        el.playbackRate = speed;
        await el.play().catch(() => setError("Tap Play to start (the browser blocked playback)."));
        // The next reply renders while this one plays, so carrying on has no gap.
        const i = replies.findIndex((x) => x.uuid === entry.uuid);
        const after = replies[i + 1];
        if (after) void renderOf(after).catch(() => {});
      } catch {
        setError("Couldn't render this reply. Is the speech engine running?");
      } finally {
        setLoading(false);
      }
    },
    [renderOf, replies, speed],
  );

  /** iOS counts a tap as permission to play only inside the tap's own task: unlock on the first one. */
  const unlock = useCallback(() => {
    const el = audio.current;
    if (el && !unlocked.current) {
      unlocked.current = true;
      el.src = silenceUrl();
      void el.play().then(() => el.pause()).catch(() => {});
    }
  }, []);

  const index = current ? replies.findIndex((r) => r.uuid === current.uuid) : -1;

  const togglePlay = useCallback(async () => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    unlock();
    if (current && el.src === current.url && !el.ended) {
      await el.play().catch(() => {});
      return;
    }
    const newest = replies.at(-1);
    if (newest) await playEntry(newest);
  }, [playing, current, replies, playEntry, unlock]);

  const step = useCallback(
    (dir: -1 | 1) => {
      const el = audio.current;
      unlock();
      if (dir === -1 && el && current && el.currentTime > RESTART_AFTER_S) {
        el.currentTime = 0;
        setNow(0);
        return;
      }
      const target = replies[(index < 0 ? replies.length : index) + dir];
      if (target) void playEntry(target);
    },
    [current, index, replies, playEntry, unlock],
  );
  const prev = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);

  const playFrom = useCallback(
    (uuid: string) => {
      unlock();
      const entry = replies.find((r) => r.uuid === uuid);
      if (entry) void playEntry(entry);
    },
    [replies, playEntry, unlock],
  );

  // Carry on into the newer replies; stop after the newest.
  const onEnded = () => {
    setPlaying(false);
    const after = index >= 0 ? replies[index + 1] : undefined;
    if (after) void playEntry(after);
  };

  const seekTo = useCallback(
    (t: number) => {
      const el = audio.current;
      if (!el || !current) return;
      el.currentTime = snapSeek(current.words, t, el.duration || duration);
      setNow(el.currentTime);
    },
    [current, duration],
  );
  const back = useCallback(() => seekTo((audio.current?.currentTime ?? 0) - SEEK_STEP_S), [seekTo]);
  const fwd = useCallback(() => seekTo((audio.current?.currentTime ?? 0) + SEEK_STEP_S), [seekTo]);

  // ── Autoplay: when switched on, each new whole reply plays as it lands ─────
  const lastAuto = useRef<string | null>(reply?.uuid ?? null);
  useEffect(() => {
    if (!autoplay || !reply || reply.partial || lastAuto.current === reply.uuid) return;
    lastAuto.current = reply.uuid;
    void playEntry(reply);
  }, [autoplay, reply, playEntry]);

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

  // ── Steering-wheel and lock-screen buttons: track = a whole reply, seek = 5 s ─────
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.metadata = new MediaMetadata({ title: paneLabel, artist: "Collie car mode" });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void togglePlay()],
      ["pause", () => audio.current?.pause()],
      ["seekbackward", back],
      ["seekforward", fwd],
      ["previoustrack", prev],
      ["nexttrack", next],
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
  }, [paneLabel, togglePlay, back, fwd, prev, next]);

  // ── The swipe: agents with something going on, in a stable order ──────────
  const lineup = useMemo(() => {
    const keys = nextLineup(carSession.lineup, agents, here, Date.now());
    return keys.flatMap((k) => agents.filter((a) => paneRowKey(a) === k));
  }, [agents, here]);
  useEffect(() => {
    carSession.lineup = lineup.map(paneRowKey);
  }, [lineup]);
  const at = lineup.findIndex((a) => paneRowKey(a) === here);
  const left = at > 0 ? lineup[at - 1] : undefined;
  const right = at >= 0 ? lineup[at + 1] : undefined;
  const go = useCallback(
    (pane: AgentView | undefined) => {
      if (!pane) return;
      audio.current?.pause();
      onSwitch(pane);
    },
    [onSwitch],
  );

  // Touch: one finger sideways is a swipe (not inside a table that scrolls itself), two fingers pinch
  // the text size. The document still scrolls up and down natively.
  const touch = useRef<{ x: number; y: number; t: number; free: boolean } | null>(null);
  const pinch = useRef<{ d: number; scale: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinch.current = { d: spread(e), scale };
      touch.current = null;
      return;
    }
    const t = e.touches[0];
    const inTable = e.target instanceof Element && e.target.closest("[data-hscroll]") !== null;
    touch.current = t ? { x: t.clientX, y: t.clientY, t: Date.now(), free: !inTable } : null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const p = pinch.current;
    if (!p || e.touches.length !== 2 || p.d === 0) return;
    setScale(Math.min(SCALE_MAX, Math.max(SCALE_MIN, p.scale * (spread(e) / p.d))));
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (pinch.current) {
      if (e.touches.length < 2) {
        pinch.current = null;
        try {
          globalThis.localStorage?.setItem(SCALE_KEY, String(scale));
        } catch {
          /* a private window keeps the size for this visit */
        }
      }
      return;
    }
    const s = touch.current;
    touch.current = null;
    const t = e.changedTouches[0];
    if (!s || !t || !s.free || Date.now() - s.t > SWIPE_MS) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
    go(dx < 0 ? right : left);
  };

  // ── Talk: live words; Send sends, or quiet does when Autoplay is on ─────
  const [talkNote, setTalkNote] = useState<string | null>(null);
  const sendTalk = useRef<() => Promise<void>>(async () => {});
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  const talk = useCarTalk({ onSilence: () => { if (autoplayRef.current) void sendTalk.current(); } });
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

  // ── What to mark ──────────────────────────────────────────────────────────
  const active = useMemo((): CarActive | null => {
    if (!current) return null;
    const i = wordAt(current.words, now);
    const word = i >= 0 ? current.words[i] : undefined;
    return word ? { uuid: current.uuid, word } : null;
  }, [current, now]);

  const line = carStatusLine(status, replies.length > 0);
  const overlay =
    talking || talk.phase === "error" ? (
      <p className="text-4xl leading-snug font-semibold">
        {talk.phase === "error" ? (
          talk.error
        ) : talk.committed || talk.pending ? (
          <>
            {talk.committed} <span className="italic opacity-55">{talk.pending}</span>
          </>
        ) : (
          <span className="opacity-55">{talk.phase === "starting" ? "Starting the mic…" : "Listening…"}</span>
        )}
      </p>
    ) : talkNote ? (
      <button type="button" onClick={() => setTalkNote(null)} className="w-full text-left text-3xl leading-snug font-semibold">
        {talkNote} <span className="text-base font-normal text-muted-foreground">(tap to close)</span>
      </button>
    ) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground" role="region" aria-label="Car mode">
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the captions ARE this view: the word on screen, live. */}
      <audio
        ref={audio}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />

      <header className="flex items-center gap-1 px-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Neighbour pane={left} side="left" onGo={go} />
        <div className="min-w-0 flex-1 truncate text-center text-xl font-black uppercase">{paneLabel}</div>
        <Neighbour pane={right} side="right" onGo={go} />
        <button type="button" onClick={onExit} className="rounded-lg p-3" aria-label="Exit car mode">
          <X className="size-7" />
        </button>
      </header>
      <div className="flex items-center gap-3 px-4 pb-2 text-lg" aria-live="polite">
        <StatusDot status={status} live className="size-5" />
        <p className="min-w-0 flex-1">
          <span className="font-bold">{line.word}</span> <span className="text-muted-foreground">{line.play}</span>
        </p>
        <label className="flex shrink-0 items-center gap-2 text-base font-medium">
          <input type="checkbox" className="size-6" checked={autoplay} onChange={(e) => setAutoplay(e.currentTarget.checked)} />
          Autoplay {autoplay ? "on" : "off"}
        </label>
      </div>

      <main
        className="relative min-h-0 flex-1"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <CarDocument
          feed={feed}
          scripts={scriptOf}
          active={active}
          current={current?.uuid ?? null}
          scale={scale}
          hasMore={data.hasMore}
          loadingOlder={data.loadingOlder}
          onLoadOlder={data.loadOlder}
          onPlayFrom={playFrom}
        />
        {(overlay || error) && (
          <div className="absolute inset-x-0 top-0 border-b-4 border-foreground bg-background p-4">
            {overlay ?? <p className="text-2xl font-semibold">{error}</p>}
          </div>
        )}
      </main>

      {talking && (
        <footer className="flex gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={() => talk.cancel()} className="h-24 flex-1 rounded-2xl border-4 border-foreground text-2xl font-bold">
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

      <footer className={`border-t border-rule px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] ${talking ? "hidden" : ""}`}>
        {onSend && (
          <button
            type="button"
            onClick={startTalk}
            className="mb-2 flex h-16 w-full items-center justify-center gap-3 rounded-2xl border-4 border-foreground text-2xl font-black"
          >
            <Mic className="size-8" />
            Talk
          </button>
        )}
        <input
          type="range"
          aria-label="Timeline"
          className="h-8 w-full"
          min={0}
          max={duration || 0}
          step={0.1}
          value={now}
          disabled={!current}
          onChange={(e) => seekTo(Number(e.currentTarget.value))}
        />
        <div className="flex justify-between text-base tabular-nums">
          <span>{fmt(now)}</span>
          <span>{fmt(duration)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <button type="button" onClick={prev} disabled={replies.length === 0} className="rounded-2xl p-2 disabled:opacity-40" aria-label="Previous reply">
            <SkipBack className="size-9" />
          </button>
          <button type="button" onClick={back} disabled={!current} className="flex flex-col items-center rounded-2xl p-2 disabled:opacity-40" aria-label="Back 5 seconds">
            <RotateCcw className="size-9" />
            <span className="text-xs font-semibold">5s</span>
          </button>
          <button
            type="button"
            onClick={() => void togglePlay()}
            disabled={replies.length === 0 || loading}
            className="flex size-24 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="size-12" /> : <Play className="size-12" />}
          </button>
          <button type="button" onClick={fwd} disabled={!current} className="flex flex-col items-center rounded-2xl p-2 disabled:opacity-40" aria-label="Forward 5 seconds">
            <RotateCw className="size-9" />
            <span className="text-xs font-semibold">5s</span>
          </button>
          <button
            type="button"
            onClick={next}
            disabled={index < 0 || index >= replies.length - 1}
            className="rounded-2xl p-2 disabled:opacity-40"
            aria-label="Next reply"
          >
            <SkipForward className="size-9" />
          </button>
        </div>
        <div className="mt-2 flex justify-center gap-2" role="group" aria-label="Speed">
          {CAR_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`rounded-lg border-2 px-3 py-1 text-base ${speed === s ? "border-foreground font-black underline" : "border-transparent"}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

/** The agent beside this one in the swipe: an arrow, its status shape and its name. */
function Neighbour({ pane, side, onGo }: { pane: AgentView | undefined; side: "left" | "right"; onGo: (p: AgentView) => void }) {
  if (!pane) return <span className="w-[30%] shrink-0" />;
  const name = paneName(pane);
  return (
    <button
      type="button"
      onClick={() => onGo(pane)}
      aria-label={`Switch to ${name}`}
      className={`flex h-12 w-[30%] shrink-0 items-center gap-1 rounded-lg px-1 text-base font-semibold ${side === "right" ? "flex-row-reverse text-right" : ""}`}
    >
      {side === "left" ? <ChevronLeft className="size-6 shrink-0" /> : <ChevronRight className="size-6 shrink-0" />}
      <StatusDot status={shownStatus(pane)} className="size-4" />
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}
