"use client";

import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface ABPlayerProps {
  clientUrl: string | null;
  referenceUrl: string;
  /** Lifted transport so artwork / carousel can share play state. */
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /**
   * `inline` — circular A/B under artwork (lightbox).
   * `bar` — compact labeled row (fallback / other surfaces).
   */
  layout?: "inline" | "bar";
}

type Source = "client" | "reference";

/**
 * Instant A/B switch between client and reference. Both elements stay
 * loaded; we mute/unmute and sync currentTime so the cut feels seamless.
 */
export function ABPlayer({
  clientUrl,
  referenceUrl,
  playing,
  onPlayingChange,
  layout = "inline",
}: ABPlayerProps) {
  const clientRef = useRef<HTMLAudioElement>(null);
  const referenceRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<Source>("reference");

  useEffect(() => {
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    if (client) client.muted = source !== "client";
    reference.muted = source !== "reference";
  }, [source]);

  // New track — reset transport; parent also clears `playing` on index change.
  useEffect(() => {
    const client = clientRef.current;
    const reference = referenceRef.current;
    client?.pause();
    reference?.pause();
    if (client) client.currentTime = 0;
    if (reference) reference.currentTime = 0;
  }, [referenceUrl, clientUrl]);

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

  function activate(next: Source) {
    if (next === "client" && !clientUrl) return;

    if (source === next && playing) {
      onPlayingChange(false);
      return;
    }

    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    const t =
      source === "reference" ? reference.currentTime : (client?.currentTime ?? 0);
    if (client) client.currentTime = t;
    reference.currentTime = t;
    setSource(next);
    onPlayingChange(true);
  }

  return (
    <div className="flex flex-col items-center gap-2">
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

      {layout === "inline" ? (
        <div className="flex items-end gap-4">
          <TransportButton
            label="Your track"
            accent="client"
            disabled={!clientUrl}
            active={source === "client"}
            playing={playing && source === "client"}
            onClick={() => activate("client")}
            title={
              clientUrl
                ? "Play your uploaded track"
                : "Client audio unavailable for this session"
            }
          />
          <TransportButton
            label="Reference"
            accent="reference"
            disabled={false}
            active={source === "reference"}
            playing={playing && source === "reference"}
            onClick={() => activate("reference")}
            title="Play reference preview"
            size="lg"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <TransportButton
            label="Your track"
            accent="client"
            disabled={!clientUrl}
            active={source === "client"}
            playing={playing && source === "client"}
            onClick={() => activate("client")}
            title={
              clientUrl
                ? "Play your uploaded track"
                : "Client audio unavailable for this session"
            }
          />
          <TransportButton
            label="Reference"
            accent="reference"
            disabled={false}
            active={source === "reference"}
            playing={playing && source === "reference"}
            onClick={() => activate("reference")}
            title="Play reference preview"
          />
        </div>
      )}
    </div>
  );
}

function TransportButton({
  label,
  accent,
  disabled,
  active,
  playing,
  onClick,
  title,
  size = "md",
}: {
  label: string;
  accent: "client" | "reference";
  disabled: boolean;
  active: boolean;
  playing: boolean;
  onClick: () => void;
  title: string;
  size?: "md" | "lg";
}) {
  const isClient = accent === "client";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        title={title}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        aria-pressed={active}
        className={cn(
          "flex items-center justify-center rounded-full ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          size === "lg" ? "size-12" : "size-11",
          active
            ? isClient
              ? "bg-client text-client-foreground ring-client"
              : "bg-reference text-surface-0 ring-reference"
            : "bg-surface-2 text-text-primary ring-border hover:bg-surface-0",
        )}
      >
        {playing ? (
          <PauseIcon className={size === "lg" ? "size-5" : "size-4"} />
        ) : (
          <PlayIcon
            className={cn(
              size === "lg" ? "size-5" : "size-4",
              "translate-x-0.5",
            )}
          />
        )}
      </button>
      <span
        className={cn(
          "text-[11px]",
          active ? "text-text-primary" : "text-text-muted",
        )}
      >
        {label}
      </span>
    </div>
  );
}
