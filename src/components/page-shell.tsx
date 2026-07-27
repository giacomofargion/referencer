import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PageShellProps {
  children: ReactNode;
  /** Extra classes on the main content column (default max-w-3xl studio shell). */
  className?: string;
}

/**
 * Shared studio page chrome — subtle grid/glow backdrop + consistent
 * content column so Home, History, Projects, and sessions feel one-tier.
 */
export function PageShell({ children, className }: PageShellProps) {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px]"
      >
        <div className="grid-texture absolute inset-0" />
        <div className="hero-glow absolute inset-0" />
      </div>
      <main
        className={cn(
          "relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12",
          className,
        )}
      >
        {children}
      </main>
    </>
  );
}
