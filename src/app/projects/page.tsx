"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSessionDate } from "@/lib/format";

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
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
            Projects
          </h1>
          <p className="text-sm text-text-secondary">
            Client jobs with match sessions and a shortlist of saved references.
          </p>
        </div>

        <form
          onSubmit={handleCreate}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
            <label htmlFor="project-name" className="text-xs text-text-muted">
              New project
            </label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Nova — single mix"
              maxLength={120}
              disabled={busy}
            />
          </div>
          <Button type="submit" disabled={busy}>
            Create
          </Button>
        </form>

        {projects === null ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No projects yet. Create one, or save a reference after matching.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border-y border-border">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex flex-col gap-1 py-4 transition-colors hover:bg-surface-1/60 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium text-text-primary">
                      {project.name}
                    </span>
                    <span className="text-xs text-text-muted">
                      {formatSessionDate(project.createdAt)}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-text-secondary">
                    {project.sessionCount} session
                    {project.sessionCount === 1 ? "" : "s"} ·{" "}
                    {project.savedCount} saved
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
