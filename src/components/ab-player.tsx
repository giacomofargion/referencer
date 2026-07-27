"use client";

import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type ABSource = "client" | "reference";

interface ABPlayerProps {
  clientUrl: string | null;
  referenceUrl: string;
  /** Lifted transport so artwork / carousel can share play state. */
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /**
   * `full` — scrubber + primary play + A/B segment (lightbox).
   * `compact` — same controls, tighter for list rows (project shortlist).
   */
  layout?: "full" | "compact";
  /** Space / A·B / 1·2 hotkeys when the listening surface is focused. */
  enableHotkeys?: boolean;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Instant A/B switch between client and reference. Both elements stay
 * loaded; we mute/unmute and sync currentTime so the cut feels seamless.
 *
 * Layout follows studio now-playing norms: scrubber first, one primary
 * play control, then a clear teal/amber A/B segment.
 */
export function ABPlayer({
  clientUrl,
  referenceUrl,
  playing,
  onPlayingChange,
  layout = "full",
  enableHotkeys = false,
}: ABPlayerProps) {
  const clientRef = useRef<HTMLAudioElement>(null);
  const referenceRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<ABSource>("reference");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const scrubbingRef = useRef(false);

  const canClient = Boolean(clientUrl);

  useEffect(() => {
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    if (client) client.muted = source !== "client";
    reference.muted = source !== "reference";
  }, [source]);

  useEffect(() => {
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    if (!playing) {
      client?.pause();
      reference.pause();
      return;
    }

    const t = reference.currentTime;
    if (client) client.currentTime = t;
    reference.currentTime = t;

    void reference.play().catch(() => {
      onPlayingChange(false);
    });
    if (client && clientUrl) {
      void client.play().catch(() => {});
    }
  }, [playing, clientUrl, referenceUrl, onPlayingChange]);

  // Drive scrubber from the audible element (both stay in sync on seek).
  useEffect(() => {
    const reference = referenceRef.current;
    if (!reference) return;

    function syncFromAudio() {
      if (scrubbingRef.current) return;
      const audio = referenceRef.current;
      if (!audio) return;
      setCurrentTime(audio.currentTime);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    }

    function onLoadedMetadata() {
      const audio = referenceRef.current;
      if (!audio) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    }

    reference.addEventListener("timeupdate", syncFromAudio);
    reference.addEventListener("loadedmetadata", onLoadedMetadata);
    onLoadedMetadata();

    return () => {
      reference.removeEventListener("timeupdate", syncFromAudio);
      reference.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [referenceUrl]);

  useEffect(() => {
    if (!enableHotkeys) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        onPlayingChange(!playing);
        return;
      }

      if (event.key === "a" || event.key === "A" || event.key === "1") {
        if (!canClient) return;
        event.preventDefault();
        setSource("client");
        if (!playing) onPlayingChange(true);
        return;
      }

      if (event.key === "b" || event.key === "B" || event.key === "2") {
        event.preventDefault();
        setSource("reference");
        if (!playing) onPlayingChange(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enableHotkeys, playing, onPlayingChange, canClient]);

  function seekTo(next: number) {
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;
    const clamped = Math.max(0, Math.min(next, duration || next));
    reference.currentTime = clamped;
    if (client) client.currentTime = clamped;
    setCurrentTime(clamped);
  }

  function setSourceAndMaybePlay(next: ABSource) {
    if (next === "client" && !canClient) return;

    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    const t =
      source === "reference"
        ? reference.currentTime
        : (client?.currentTime ?? 0);
    if (client) client.currentTime = t;
    reference.currentTime = t;
    setSource(next);
    if (!playing) onPlayingChange(true);
  }

  const listeningLabel =
    source === "client" ? "Your track" : "Reference";
  const isCompact = layout === "compact";
  const max = duration > 0 ? duration : 0;

  return (
    <div
      className={cn(
        "flex w-full flex-col",
        isCompact ? "max-w-none gap-3" : "max-w-sm gap-4",
        !isCompact && "mx-auto items-stretch",
      )}
    >
      {clientUrl && (
        <audio
          ref={clientRef}
          src={clientUrl}
          preload="auto"
          muted
          onEnded={() => onPlayingChange(false)}
        />
      )}
      <audio
        ref={referenceRef}
        src={referenceUrl}
        preload="auto"
        muted
        onEnded={() => onPlayingChange(false)}
      />

      {canClient ? (
        <p
          className={cn(
            "text-center text-xs",
            source === "client" ? "text-client" : "text-reference",
          )}
          aria-live="polite"
        >
          Listening to{" "}
          <span className="font-medium text-text-primary">
            {listeningLabel}
          </span>
        </p>
      ) : null}

      <div className="flex items-center gap-2.5">
        <span className="w-9 shrink-0 text-right font-mono text-[11px] text-text-muted tabular-nums">
          {formatTime(currentTime)}
        </span>
        <input
          type="range"
          min={0}
          max={max || 1}
          step={0.01}
          value={max > 0 ? Math.min(currentTime, max) : 0}
          disabled={max <= 0}
          aria-label="Seek"
          className={cn(
            "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-client disabled:cursor-not-allowed disabled:opacity-40",
            source === "reference" && "accent-reference",
          )}
          onPointerDown={() => {
            scrubbingRef.current = true;
          }}
          onPointerUp={(event) => {
            scrubbingRef.current = false;
            seekTo(Number(event.currentTarget.value));
          }}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            setCurrentTime(next);
            if (!scrubbingRef.current) seekTo(next);
          }}
        />
        <span className="w-9 shrink-0 font-mono text-[11px] text-text-muted tabular-nums">
          {formatTime(duration)}
        </span>
      </div>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={() => onPlayingChange(!playing)}
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          className={cn(
            "flex items-center justify-center rounded-full bg-text-primary text-surface-0 transition-opacity hover:opacity-90",
            isCompact ? "size-11" : "size-14",
          )}
        >
          {playing ? (
            <PauseIcon className={isCompact ? "size-4" : "size-5"} />
          ) : (
            <PlayIcon
              className={cn(
                isCompact ? "size-4" : "size-5",
                "translate-x-0.5",
              )}
            />
          )}
        </button>

        {canClient ? (
          <div
            role="group"
            aria-label="A/B source"
            className="flex w-full rounded-lg bg-surface-2 p-1 ring-1 ring-border"
          >
            <SourceSegment
              label="Your track"
              hint="A · 1"
              active={source === "client"}
              accent="client"
              onClick={() => setSourceAndMaybePlay("client")}
            />
            <SourceSegment
              label="Reference"
              hint="B · 2"
              active={source === "reference"}
              accent="reference"
              onClick={() => setSourceAndMaybePlay("reference")}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SourceSegment({
  label,
  hint,
  active,
  accent,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  accent: "client" | "reference";
  onClick: () => void;
}) {
  const isClient = accent === "client";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${label} (${hint})`}
      className={cn(
        "flex flex-1 flex-col items-center gap-0.5 rounded-md px-3 py-2 text-xs transition-colors",
        active
          ? isClient
            ? "bg-client text-client-foreground"
            : "bg-reference text-surface-0"
          : "text-text-muted hover:text-text-primary",
      )}
    >
      <span className="font-medium">{label}</span>
      <span
        className={cn(
          "font-mono text-[10px]",
          active ? "opacity-70" : "text-text-muted",
        )}
      >
        {hint}
      </span>
    </button>
  );
}
