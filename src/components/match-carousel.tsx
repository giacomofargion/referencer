"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  type PanInfo,
} from "motion/react";

import { ABPlayer } from "@/components/ab-player";
import type { MatchResult } from "@/components/match-card";
import { Button } from "@/components/ui/button";
import { fadeInUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

const CARD_SIZE_MAX = 280;
const CARD_SIZE_MIN = 168;
/** Side inset so peek of neighbors + chevrons fit on narrow screens. */
const CARD_SIDE_INSET = 56;
const CARD_GAP = 24;
const ACTIVE_LIFT_DESKTOP = 24;
const ACTIVE_LIFT_MOBILE = 12;
const DRAG_THRESHOLD = 48;
const VELOCITY_THRESHOLD = 400;

interface MatchCarouselProps {
  matches: MatchResult[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onPlayingChange: (playing: boolean) => void;
  clientPlaybackUrl: string | null;
}

/** iTunes serves sized artwork URLs — bump so carousel cards stay sharp. */
export function enlargeArtworkUrl(url: string | null, size = 600): string | null {
  if (!url) return null;
  return url.replace(/\d+x\d+bb/, `${size}x${size}bb`);
}

function cardMetrics(containerWidth: number) {
  const cardSize = Math.min(
    CARD_SIZE_MAX,
    Math.max(CARD_SIZE_MIN, containerWidth - CARD_SIDE_INSET * 2),
  );
  const compact = containerWidth < 480;
  return {
    cardSize,
    cardGap: CARD_GAP,
    step: cardSize + CARD_GAP,
    activeLift: compact ? ACTIVE_LIFT_MOBILE : ACTIVE_LIFT_DESKTOP,
    compact,
  };
}

function centerOffsetFor(
  containerWidth: number,
  cardSize: number,
  step: number,
  index: number,
): number {
  return containerWidth / 2 - cardSize / 2 - index * step;
}

export function MatchCarousel({
  matches,
  activeIndex,
  onActiveIndexChange,
  playing,
  onTogglePlay,
  onPlayingChange,
  clientPlaybackUrl,
}: MatchCarouselProps) {
  const trackX = useMotionValue(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef(activeIndex);
  const dragMovedRef = useRef(false);
  const [metrics, setMetrics] = useState(() => cardMetrics(360));
  const active = matches[activeIndex];
  const { cardSize, cardGap, step, activeLift, compact } = metrics;

  activeIndexRef.current = activeIndex;

  // Size the cards to the column; only snap position on resize (not on index
  // change — that would fight the spring and look like a hitch).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function sync() {
      const width = containerRef.current?.clientWidth ?? 360;
      const next = cardMetrics(width);
      setMetrics(next);
      trackX.set(
        centerOffsetFor(width, next.cardSize, next.step, activeIndexRef.current),
      );
    }

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [trackX]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || matches.length === 0) return;

    void animate(
      trackX,
      centerOffsetFor(container.clientWidth, cardSize, step, activeIndex),
      {
        type: "spring",
        stiffness: 280,
        damping: 32,
        mass: 0.85,
      },
    );
  }, [activeIndex, matches.length, trackX, cardSize, step]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onActiveIndexChange(Math.max(0, activeIndex - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onActiveIndexChange(Math.min(matches.length - 1, activeIndex + 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, matches.length, onActiveIndexChange]);

  function handleDragEnd(_: unknown, info: PanInfo) {
    const { offset, velocity } = info;
    if (Math.abs(offset.x) > 8 || Math.abs(velocity.x) > 50) {
      dragMovedRef.current = true;
    }

    let next = activeIndex;
    if (offset.x < -DRAG_THRESHOLD || velocity.x < -VELOCITY_THRESHOLD) {
      next = Math.min(matches.length - 1, activeIndex + 1);
    } else if (offset.x > DRAG_THRESHOLD || velocity.x > VELOCITY_THRESHOLD) {
      next = Math.max(0, activeIndex - 1);
    }
    onActiveIndexChange(next);

    const container = containerRef.current;
    if (container) {
      void animate(
        trackX,
        centerOffsetFor(container.clientWidth, cardSize, step, next),
        {
          type: "spring",
          stiffness: 280,
          damping: 32,
          mass: 0.85,
        },
      );
    }
  }

  function handleCardClick(index: number, isActive: boolean) {
    // Framer fires click after a swipe; ignore that synthetic one.
    if (dragMovedRef.current) return;
    if (isActive) onTogglePlay();
    else onActiveIndexChange(index);
  }

  if (matches.length === 0 || !active) return null;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="relative">
        <div
          ref={containerRef}
          className="overflow-hidden"
          style={{ paddingTop: activeLift + 8, paddingBottom: 8 }}
        >
          <motion.div
            className="flex cursor-grab items-end active:cursor-grabbing"
            style={{
              x: trackX,
              gap: cardGap,
              width: matches.length * step,
            }}
            drag="x"
            dragConstraints={{ left: -Infinity, right: Infinity }}
            dragElastic={0.12}
            onPointerDown={() => {
              dragMovedRef.current = false;
            }}
            onDrag={(_, info) => {
              if (Math.abs(info.offset.x) > 8) dragMovedRef.current = true;
            }}
            onDragEnd={handleDragEnd}
          >
            {matches.map((match, index) => {
              const isActive = index === activeIndex;
              const art = enlargeArtworkUrl(match.artworkUrl);

              return (
                <motion.button
                  key={match.id}
                  type="button"
                  onClick={() => handleCardClick(index, isActive)}
                  aria-label={
                    isActive
                      ? playing
                        ? `Pause ${match.title}`
                        : `Play ${match.title}`
                      : `${match.title} by ${match.artist}`
                  }
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "group relative shrink-0 overflow-hidden rounded-xl outline-none sm:rounded-2xl",
                    "focus-visible:ring-2 focus-visible:ring-client",
                    isActive && "card-glossy",
                  )}
                  style={{ width: cardSize, height: cardSize }}
                  animate={{
                    y: isActive ? -activeLift : 0,
                    scale: isActive ? 1.04 : 0.9,
                    opacity: isActive ? 1 : 0.5,
                  }}
                  transition={{ type: "spring", stiffness: 320, damping: 30 }}
                >
                  {art ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote iTunes artwork URLs vary
                    <img
                      src={art}
                      alt=""
                      draggable={false}
                      className="pointer-events-none size-full object-cover"
                    />
                  ) : (
                    <div className="size-full bg-surface-2" />
                  )}

                  <span
                    className={cn(
                      "absolute top-2 right-2 rounded-full px-2 py-0.5 font-mono text-[10px] backdrop-blur-sm sm:top-3 sm:right-3",
                      isActive
                        ? "bg-surface-0/70 text-text-primary"
                        : "bg-surface-0/50 text-text-muted",
                    )}
                  >
                    #{index + 1}
                  </span>
                </motion.button>
              );
            })}
          </motion.div>
        </div>

        {matches.length > 1 && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={activeIndex === 0}
              onClick={() => onActiveIndexChange(activeIndex - 1)}
              aria-label="Previous reference"
              className="absolute top-1/2 left-0 z-10 hidden -translate-y-1/2 bg-surface-0/60 backdrop-blur-sm disabled:opacity-30 sm:inline-flex"
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={activeIndex === matches.length - 1}
              onClick={() => onActiveIndexChange(activeIndex + 1)}
              aria-label="Next reference"
              className="absolute top-1/2 right-0 z-10 hidden -translate-y-1/2 bg-surface-0/60 backdrop-blur-sm disabled:opacity-30 sm:inline-flex"
            >
              <ChevronRightIcon className="size-5" />
            </Button>

            {/* Dot strip on phones — swipe is primary; arrows clutter the art. */}
            <div
              className="mt-1 flex justify-center gap-1.5 sm:hidden"
              aria-hidden
            >
              {matches.map((match, index) => (
                <button
                  key={`dot-${match.id}`}
                  type="button"
                  onClick={() => onActiveIndexChange(index)}
                  aria-label={`Reference ${index + 1}`}
                  className={cn(
                    "size-1.5 rounded-full transition-colors",
                    index === activeIndex ? "bg-client" : "bg-surface-2",
                  )}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col items-center gap-4 sm:gap-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`meta-${active.id}`}
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="flex max-w-full flex-col items-center gap-1 px-1 text-center"
          >
            <h3 className="text-lg font-semibold tracking-tight text-text-primary sm:text-2xl">
              {active.title}
            </h3>
            <p className="line-clamp-2 text-sm text-text-secondary">
              {active.artist}
              {active.album ? ` · ${active.album}` : ""}
            </p>
            <p className="font-mono text-xs text-text-muted">
              {active.genre} · score {active.distanceScore.toFixed(2)}
            </p>
          </motion.div>
        </AnimatePresence>

        <div className="w-full max-w-sm px-1">
          <ABPlayer
            key={`player-${active.id}`}
            clientUrl={clientPlaybackUrl}
            referenceUrl={active.previewUrl}
            referenceStartSec={active.previewStartSec}
            playing={playing}
            onPlayingChange={onPlayingChange}
            layout={compact ? "compact" : "full"}
            enableHotkeys
          />
        </div>
      </div>
    </div>
  );
}
