"use client";

import Link from "next/link";
import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";

import { Button } from "@/components/ui/button";

export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-0/70 px-6 backdrop-blur-md">
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight text-text-primary">
            Tonemap
          </span>
          <span className="hidden text-xs text-text-muted sm:inline">
            Sonic reference matching for mastering
          </span>
        </Link>
        <Show when="signed-in">
          <nav className="flex items-center gap-3 text-sm">
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
        </Show>
      </div>
      <div className="flex items-center gap-2">
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
