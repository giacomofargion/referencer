"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { formatSessionDate } from "@/lib/format";

interface SessionRow {
  id: string;
  title: string;
  createdAt: string;
  projectId: string | null;
  projectName: string | null;
  matchCount: number;
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/sessions");
        if (!response.ok) {
          const { error } = await response.json();
          throw new Error(error ?? "Could not load history");
        }
        const data = (await response.json()) as { sessions: SessionRow[] };
        if (!cancelled) setSessions(data.sessions);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not load history",
        );
        if (!cancelled) setSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <AppHeader />
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
            History
          </h1>
          <p className="text-sm text-text-secondary">
            Past match sessions — reopen to review references and save keepers
            to a project.
          </p>
        </div>

        {sessions === null ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No sessions yet.{" "}
            <Link href="/" className="text-client underline-offset-2 hover:underline">
              Analyze a track
            </Link>{" "}
            to get started.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border-y border-border">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  className="flex flex-col gap-1 py-4 transition-colors hover:bg-surface-1/60 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium text-text-primary">
                      {session.title}
                    </span>
                    <span className="text-xs text-text-muted">
                      {formatSessionDate(session.createdAt)}
                      {session.projectName
                        ? ` · ${session.projectName}`
                        : " · Unassigned"}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-text-secondary">
                    {session.matchCount} ref
                    {session.matchCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
