import type { Transition, Variants } from "motion/react";

/** Shared motion presets — keep durations/easings consistent app-wide. */

export const easeOutSoft = [0.22, 1, 0.36, 1] as const;

export const duration = {
  fast: 0.15,
  base: 0.25,
  slow: 0.4,
} as const;

export const transitionFast: Transition = {
  duration: duration.fast,
  ease: easeOutSoft,
};

export const transitionBase: Transition = {
  duration: duration.base,
  ease: easeOutSoft,
};

export const transitionSlow: Transition = {
  duration: duration.slow,
  ease: easeOutSoft,
};

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: transitionBase,
  },
};

export const staggerChildren: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.06,
    },
  },
};
