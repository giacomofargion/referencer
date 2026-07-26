"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSessionDate } from "@/lib/format";
import { fadeInUp, staggerChildren } from "@/lib/motion";

interface ProjectRow {
  id: string;
  name: string;
  createdAt: string;
  sessionCount: number;
  savedCount: number;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadProjects() {
    const response = await fetch("/api/projects");
    if (!response.ok) {
      const { error } = await response.json();
      throw new Error(error ?? "Could not load projects");
    }
    const data = (await response.json()) as { projects: ProjectRow[] };
    setProjects(data.projects);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadProjects();
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error ? error.message : "Could not load projects",
          );
          setProjects([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter a project name");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error ?? "Could not create project");
      }
      setName("");
      await loadProjects();
      toast.success("Project created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create project",
      );
    } finally {
      setBusy(false);
    }
  }

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
            Projects
          </h1>

        </motion.div>

        <motion.form
          onSubmit={handleCreate}
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.05 }}
          className="flex flex-col gap-6 rounded-xl border border-border bg-surface-1 px-6 py-7"
        >
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-medium text-text-primary">
              New project
            </h2>
            <p className="text-sm leading-relaxed text-text-muted">
              Name it after the client or release you’re working on.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-col">
              <label htmlFor="project-name" className="sr-only">
                Project name
              </label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. The Beatles — Let It Be"
                maxLength={120}
                disabled={busy}
                className="h-10"
              />
            </div>
            <Button type="submit" disabled={busy} className="h-10 shrink-0 px-5">
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </motion.form>

        <section className="flex flex-col gap-6">
          <motion.div
            className="flex items-baseline justify-between gap-4"
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            transition={{ delay: 0.1 }}
          >
            <h2 className="text-base mt-5 font-medium text-text-primary">
              Your projects
            </h2>
            {projects && projects.length > 0 ? (
              <span className="text-sm text-text-muted">
                {projects.length} total
              </span>
            ) : null}
          </motion.div>

          {projects === null ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : projects.length === 0 ? (
            <motion.div
              variants={fadeInUp}
              initial="hidden"
              animate="visible"
              className="rounded-xl border border-dashed border-border bg-surface-0 px-6 py-14 text-center"
            >
              <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-secondary">
                No projects yet. Create one above, or save a reference after
                matching — we’ll attach it to a job.
              </p>
            </motion.div>
          ) : (
            <motion.ul
              className="flex flex-col gap-4"
              variants={staggerChildren}
              initial="hidden"
              animate="visible"
            >
              {projects.map((project) => (
                <motion.li key={project.id} variants={fadeInUp}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="group flex items-center gap-6 rounded-xl border border-border bg-surface-1 px-5 py-6 transition-colors hover:border-text-muted hover:bg-surface-2"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="truncate text-lg font-medium tracking-tight text-text-primary transition-colors group-hover:text-client">
                        {project.name}
                      </span>
                      <span className="text-sm text-text-muted">
                        Created {formatSessionDate(project.createdAt)}
                      </span>
                    </div>

                    <div className="hidden shrink-0 items-center gap-2 sm:flex">
                      <span className="rounded-md bg-surface-0 px-2.5 py-1 font-mono text-xs text-text-secondary">
                        {project.sessionCount} session
                        {project.sessionCount === 1 ? "" : "s"}
                      </span>
                      <span className="rounded-md bg-surface-0 px-2.5 py-1 font-mono text-xs text-text-secondary">
                        {project.savedCount} saved
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 text-text-secondary">
                      <span className="hidden text-sm sm:inline">Open</span>
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
        </section>
      </main>
    </>
  );
}
