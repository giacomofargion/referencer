"use client";

import { useEffect, useRef } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  animate,
  motion,
  useMotionValue,
  type PanInfo,
} from "motion/react";

import type { MatchResult } from "@/components/match-card";
import { Button } from "@/components/ui/button";
import { fadeInUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

const CARD_SIZE = 200;
const CARD_GAP = 28;
const STEP = CARD_SIZE + CARD_GAP;
/** How far the active card lifts above its inactive neighbors. */
const ACTIVE_LIFT = 28;
const DRAG_THRESHOLD = 48;
const VELOCITY_THRESHOLD = 400;

interface MatchCarouselProps {
  matches: MatchResult[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

/** iTunes serves sized artwork URLs — bump so carousel cards stay sharp. */
export function enlargeArtworkUrl(url: string | null, size = 600): string | null {
  if (!url) return null;
  return url.replace(/\d+x\d+bb/, `${size}x${size}bb`);
}

export function MatchCarousel({
  matches,
  activeIndex,
  onActiveIndexChange,
}: MatchCarouselProps) {
  const trackX = useMotionValue(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = matches[activeIndex];

  // Center the active card in the viewport
  useEffect(() => {
    const container = containerRef.current;
    if (!container || matches.length === 0) return;

    const centerOffset =
      container.clientWidth / 2 - CARD_SIZE / 2 - activeIndex * STEP;

    animate(trackX, centerOffset, {
      type: "spring",
      stiffness: 280,
      damping: 32,
      mass: 0.85,
    });
  }, [activeIndex, matches.length, trackX]);

  // Recenter on resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const centerOffset =
        container.clientWidth / 2 - CARD_SIZE / 2 - activeIndex * STEP;
      trackX.set(centerOffset);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeIndex, trackX]);

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
    let next = activeIndex;
    if (offset.x < -DRAG_THRESHOLD || velocity.x < -VELOCITY_THRESHOLD) {
      next = Math.min(matches.length - 1, activeIndex + 1);
    } else if (offset.x > DRAG_THRESHOLD || velocity.x > VELOCITY_THRESHOLD) {
      next = Math.max(0, activeIndex - 1);
    }
    onActiveIndexChange(next);

    // Snap back to the (possibly new) center even if index didn't change
    const container = containerRef.current;
    if (container) {
      const centerOffset =
        container.clientWidth / 2 - CARD_SIZE / 2 - next * STEP;
      animate(trackX, centerOffset, {
        type: "spring",
        stiffness: 280,
        damping: 32,
        mass: 0.85,
      });
    }
  }

  if (matches.length === 0 || !active) return null;

  return (
    <div className="flex flex-col gap-5">
      <div className="relative">
        <div
          ref={containerRef}
          className="overflow-hidden"
          // Extra top/bottom room so the lifted active card isn't clipped
          style={{ paddingTop: ACTIVE_LIFT + 8, paddingBottom: 8 }}
        >
          <motion.div
            className="flex cursor-grab items-end active:cursor-grabbing"
            style={{
              x: trackX,
              gap: CARD_GAP,
              width: matches.length * STEP,
            }}
            drag="x"
            dragConstraints={{ left: -Infinity, right: Infinity }}
            dragElastic={0.12}
            onDragEnd={handleDragEnd}
          >
            {matches.map((match, index) => {
              const isActive = index === activeIndex;
              const art = enlargeArtworkUrl(match.artworkUrl);

              return (
                <motion.button
                  key={match.id}
                  type="button"
                  onClick={() => onActiveIndexChange(index)}
                  aria-label={`${match.title} by ${match.artist}`}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "relative shrink-0 overflow-hidden rounded-2xl outline-none",
                    "focus-visible:ring-2 focus-visible:ring-client",
                    isActive && "card-glossy",
                  )}
                  style={{ width: CARD_SIZE, height: CARD_SIZE }}
                  animate={{
                    y: isActive ? -ACTIVE_LIFT : 0,
                    scale: isActive ? 1.06 : 0.92,
                    opacity: isActive ? 1 : 0.55,
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
                      "absolute top-3 right-3 rounded-full px-2 py-0.5 font-mono text-[10px] backdrop-blur-sm",
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
              className="absolute top-1/2 left-0 z-10 -translate-y-1/2 bg-surface-0/60 backdrop-blur-sm disabled:opacity-30"
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
              className="absolute top-1/2 right-0 z-10 -translate-y-1/2 bg-surface-0/60 backdrop-blur-sm disabled:opacity-30"
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          </>
        )}
      </div>

      <motion.div
        key={active.id}
        variants={fadeInUp}
        initial="hidden"
        animate="visible"
        className="flex flex-col items-center gap-1 text-center"
      >
        <h3 className="text-xl font-semibold tracking-tight text-text-primary">
          {active.title}
        </h3>
        <p className="text-sm text-text-secondary">
          {active.artist}
          {active.album ? ` · ${active.album}` : ""}
        </p>
        <p className="font-mono text-xs text-text-muted">
          {active.genre} · score {active.distanceScore.toFixed(2)}
        </p>
      </motion.div>
    </div>
  );
}
