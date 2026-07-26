"use client";

import Link from "next/link";
import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";

import { CreditsBalance } from "@/components/credits-balance";
import { Button } from "@/components/ui/button";

function TonemapMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
    >
      <rect width="32" height="32" rx="8" className="fill-client" />
      {/* Simple vinyl / reel mark — reads as audio without competing with the wordmark */}
      <circle cx="16" cy="16" r="9" className="stroke-client-foreground" strokeWidth="1.75" />
      <circle cx="16" cy="16" r="3" className="fill-client-foreground" />
      <path
        d="M16 7v3.5M16 21.5V25M7 16h3.5M21.5 16H25"
        className="stroke-client-foreground"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-0/70 px-6 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2.5">
        <TonemapMark className="size-7 shrink-0" />
        <span className="text-sm font-semibold tracking-wide text-text-primary">
          TONEMAP
        </span>
        <span className="hidden text-xs text-text-muted sm:inline">
          Sonic reference matching
        </span>
      </Link>

      <div className="flex items-center gap-4">
        <Show when="signed-out">
          <SignInButton mode="modal">
            <Button variant="outline" size="sm">
              Sign in
            </Button>
          </SignInButton>
          <SignUpButton mode="modal">
            <Button size="sm">Sign up</Button>
          </SignUpButton>
        </Show>
        <Show when="signed-in">
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/history"
              className="text-text-secondary transition-colors hover:text-text-primary"
            >
              History
            </Link>
            <Link
              href="/projects"
              className="text-text-secondary transition-colors hover:text-text-primary"
            >
              Projects
            </Link>
          </nav>
          <CreditsBalance />
          <UserButton
            appearance={{
              elements: {
                avatarBox: "size-8",
              },
            }}
          />
        </Show>
      </div>
    </header>
  );
}
