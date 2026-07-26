"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { formatSessionDate } from "@/lib/format";
import { fadeInUp, staggerChildren } from "@/lib/motion";

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
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-16 px-6 py-16">
        <motion.div
          className="flex flex-col gap-4"
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
        >
          <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
            History
          </h1>
          <p className="max-w-md text-sm mb-5 leading-relaxed text-text-secondary">
            Past match sessions — reopen to review references and save keepers
            to a project.
          </p>
        </motion.div>

        {sessions === null ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <motion.div
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            className="rounded-xl border border-dashed border-border bg-surface-0 px-6 py-14 text-center"
          >
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-secondary">
              No sessions yet.{" "}
              <Link
                href="/"
                className="text-client underline-offset-2 hover:underline"
              >
                Analyze a track
              </Link>{" "}
              to get started.
            </p>
          </motion.div>
        ) : (
          <motion.ul
            className="flex flex-col gap-4"
            variants={staggerChildren}
            initial="hidden"
            animate="visible"
          >
            {sessions.map((session) => (
              <motion.li key={session.id} variants={fadeInUp}>
                <Link
                  href={
                    session.projectId
                      ? `/sessions/${session.id}?from=${encodeURIComponent(`/projects/${session.projectId}`)}`
                      : `/sessions/${session.id}?from=${encodeURIComponent("/history")}`
                  }
                  className="group flex items-center gap-6 rounded-xl border border-border bg-surface-1 px-5 py-6 transition-colors hover:border-text-muted hover:bg-surface-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="truncate text-lg font-medium tracking-tight text-text-primary transition-colors group-hover:text-client">
                      {session.title}
                    </span>
                    <span className="text-sm text-text-muted">
                      {formatSessionDate(session.createdAt)}
                      {session.projectName
                        ? ` · ${session.projectName}`
                        : " · Unassigned"}
                    </span>
                  </div>

                  <span className="hidden shrink-0 rounded-md bg-surface-0 px-2.5 py-1 font-mono text-xs text-text-secondary sm:inline">
                    {session.matchCount} ref
                    {session.matchCount === 1 ? "" : "s"}
                  </span>

                  <div className="flex shrink-0 items-center gap-2 text-text-secondary">
                    <span className="hidden text-sm sm:inline">View</span>
                    <ChevronRightIcon
                      className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-client"
                      aria-hidden
                    />
                  </div>
                </Link>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </main>
    </>
  );
}
