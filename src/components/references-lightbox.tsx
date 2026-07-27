"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";

import { MatchCard, type MatchResult } from "@/components/match-card";
import { MatchCarousel } from "@/components/match-carousel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WEIGHT_PRESET_LABELS,
  type WeightPreset,
} from "@/lib/matching";
import { easeOutSoft } from "@/lib/motion";
import type { FeatureVector } from "@/lib/types";

const subscribeNoop = () => () => {};

interface ReferencesLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matches: MatchResult[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  clientFeatures: FeatureVector;
  clientPlaybackUrl: string | null;
  weightPreset: WeightPreset;
  onWeightPresetChange: (preset: WeightPreset) => void;
  discoveryNote: string | null;
  /** Optional save control for the active match (star → project shortlist). */
  renderSaveControl?: (match: MatchResult) => ReactNode;
}

export function ReferencesLightbox({
  open,
  onOpenChange,
  matches,
  activeIndex,
  onActiveIndexChange,
  clientFeatures,
  clientPlaybackUrl,
  weightPreset,
  onWeightPresetChange,
  discoveryNote,
  renderSaveControl,
}: ReferencesLightboxProps) {
  // Portals never SSR, so the hydration render must also produce nothing —
  // otherwise a lightbox that starts open (session reopen) fails hydration.
  // useSyncExternalStore gives "false during SSR/hydration, true after".
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  // Shared with carousel artwork + AB player.
  const [playing, setPlaying] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!next) setPlaying(false);
    onOpenChange(next);
  }

  function handleActiveIndexChange(index: number) {
    setPlaying(false);
    onActiveIndexChange(index);
  }

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPlaying(false);
        onOpenChange(false);
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="references-lightbox"
          className="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:p-5 md:p-8"
          role="dialog"
          aria-modal="true"
          aria-labelledby="references-lightbox-title"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: easeOutSoft }}
        >
          <motion.button
            type="button"
            aria-label="Close references"
            className="absolute inset-0 bg-surface-0/80 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: easeOutSoft }}
            onClick={() => handleOpenChange(false)}
          />

          <motion.div
            className="relative z-10 flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-none bg-surface-1 ring-1 ring-border sm:rounded-2xl"
            initial={{ opacity: 0, scale: 0.94, y: 28 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            transition={{
              type: "spring",
              stiffness: 320,
              damping: 28,
              mass: 0.85,
            }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-48"
            >
              <div className="hero-glow absolute inset-0 opacity-60" />
            </div>

            <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:items-start sm:gap-4 sm:px-8 sm:py-5">
              <div className="flex min-w-0 flex-col gap-0.5 sm:gap-1">
                <h2
                  id="references-lightbox-title"
                  className="truncate text-lg font-semibold tracking-tight text-text-primary sm:text-2xl"
                >
                  Reference matches
                </h2>
                {discoveryNote && (
                  <p className="line-clamp-2 max-w-2xl text-xs text-text-muted sm:text-sm">
                    {discoveryNote}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                <Select
                  value={weightPreset}
                  onValueChange={(value) => {
                    if (
                      value === "balanced" ||
                      value === "tone" ||
                      value === "loudness"
                    ) {
                      setPlaying(false);
                      onWeightPresetChange(value);
                    }
                  }}
                >
                  <SelectTrigger className="h-9 w-[7.5rem] sm:h-9 sm:w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(WEIGHT_PRESET_LABELS) as WeightPreset[]).map(
                      (key) => (
                        <SelectItem key={key} value={key}>
                          {WEIGHT_PRESET_LABELS[key]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleOpenChange(false)}
                  aria-label="Close"
                  className="bg-surface-0/50"
                >
                  <XIcon className="size-5" />
                </Button>
              </div>
            </header>

            <div className="relative flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-8 sm:py-8">
              {matches.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No matches this run — similarity results vary, so try
                  analyzing again.
                </p>
              ) : (
                // Mobile: single listening-first column. Desktop: player | metering.
                <div className="mx-auto flex max-w-5xl flex-col gap-6 sm:gap-8 lg:grid lg:grid-cols-2 lg:items-start lg:gap-10">
                  <MatchCarousel
                    matches={matches}
                    activeIndex={activeIndex}
                    onActiveIndexChange={handleActiveIndexChange}
                    playing={playing}
                    onTogglePlay={() => setPlaying((prev) => !prev)}
                    onPlayingChange={setPlaying}
                    clientPlaybackUrl={clientPlaybackUrl}
                  />
                  {matches[activeIndex] && (
                    <MatchCard
                      match={matches[activeIndex]}
                      clientFeatures={clientFeatures}
                      saveControl={
                        renderSaveControl
                          ? renderSaveControl(matches[activeIndex])
                          : undefined
                      }
                    />
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
