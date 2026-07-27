"use client";

import Link from "next/link";
import { useAuth, UserButton } from "@clerk/nextjs";

import { CreditsBalance } from "@/components/credits-balance";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AppHeaderProps {
  /** Brand-only chrome for auth pages (no nav / CTAs). */
  brandOnly?: boolean;
}

/** Draw-in underline in client teal — matches the Buy accent without competing with it. */
const navLinkClass =
  "relative inline-block pb-0.5 text-text-secondary transition-colors duration-300 ease-out hover:text-client after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-left after:scale-x-0 after:bg-client after:transition-transform after:duration-300 after:ease-out hover:after:scale-x-100";

export function AppHeader({ brandOnly = false }: AppHeaderProps) {
  const { isLoaded, isSignedIn } = useAuth();
  // Show auth CTAs unless we know the user is signed in. Clerk's <Show> hides
  // both branches while loading — and if the Clerk domain DNS is missing, that
  // "loading" state never resolves, so the header looked empty.
  const showSignedOutActions = !isLoaded || !isSignedIn;

  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex h-14 shrink-0 items-center border-b border-border bg-surface-0/70 px-6 backdrop-blur-md",
        brandOnly ? "justify-start" : "justify-between",
      )}
    >
      <Link href="/" className="flex items-center gap-2.5">
        <span className="text-sm font-semibold tracking-wide text-text-primary">
          TONEMAP
        </span>
        {!brandOnly && (
          <span className="hidden text-xs text-text-muted sm:inline">
            Sonic reference matching
          </span>
        )}
      </Link>

      {!brandOnly && (
        <div className="flex items-center gap-4">
          {showSignedOutActions ? (
            <>
              <Link
                href="/sign-in"
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                )}
              >
                Sign in
              </Link>
              <Link
                href="/sign-up"
                className={cn(buttonVariants({ size: "sm" }))}
              >
                Sign up
              </Link>
            </>
          ) : (
            <>
              <nav className="flex items-center gap-4 text-sm">
                <Link href="/history" className={navLinkClass}>
                  History
                </Link>
                <Link href="/projects" className={navLinkClass}>
                  Projects
                </Link>
              </nav>
              <CreditsBalance />
              <UserButton />
            </>
          )}
        </div>
      )}
    </header>
  );
}
