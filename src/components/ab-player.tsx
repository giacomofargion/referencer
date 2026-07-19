"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

interface ABPlayerProps {
  clientUrl: string | null;
  referenceUrl: string;
  clientLabel?: string;
  referenceLabel?: string;
}

type Source = "client" | "reference";

/**
 * Instant A/B switch between client and reference. Both elements stay
 * loaded; we mute/unmute and sync currentTime so the cut feels seamless.
 */
export function ABPlayer({
  clientUrl,
  referenceUrl,
  clientLabel = "Your track",
  referenceLabel = "Reference",
}: ABPlayerProps) {
  const clientRef = useRef<HTMLAudioElement>(null);
  const referenceRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<Source>("reference");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!client || !reference) return;

    client.muted = source !== "client";
    reference.muted = source !== "reference";
  }, [source]);

  async function togglePlay() {
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    if (playing) {
      client?.pause();
      reference.pause();
      setPlaying(false);
      return;
    }

    // Sync both to the active transport position before playing.
    const t = reference.currentTime;
    if (client) client.currentTime = t;
    reference.currentTime = t;

    const plays: Promise<void>[] = [reference.play()];
    if (client && clientUrl) plays.push(client.play());
    await Promise.all(plays);
    setPlaying(true);
  }

  function switchTo(next: Source) {
    if (next === "client" && !clientUrl) return;
    const client = clientRef.current;
    const reference = referenceRef.current;
    if (!reference) return;

    const t =
      source === "reference" ? reference.currentTime : (client?.currentTime ?? 0);
    if (client) client.currentTime = t;
    reference.currentTime = t;
    setSource(next);
  }

  return (
    <div className="flex flex-col gap-2">
      {clientUrl && (
        <audio ref={clientRef} src={clientUrl} preload="auto" muted />
      )}
      <audio ref={referenceRef} src={referenceUrl} preload="auto" muted />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={togglePlay}>
          {playing ? "Pause" : "Play"}
        </Button>
        <div className="flex rounded-lg border border-border bg-surface-0 p-0.5">
          <button
            type="button"
            disabled={!clientUrl}
            onClick={() => switchTo("client")}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              source === "client"
                ? "bg-client text-client-foreground"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            A · {clientLabel}
          </button>
          <button
            type="button"
            onClick={() => switchTo("reference")}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              source === "reference"
                ? "bg-reference text-surface-0"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            B · {referenceLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
