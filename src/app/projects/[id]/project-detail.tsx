"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";

import { ABPlayer } from "@/components/ab-player";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSessionDate } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SessionRow {
  id: string;
  title: string;
  createdAt: string;
  matchCount: number;
}

interface SavedRow {
  savedId: string;
  note: string | null;
  savedAt: string;
  id: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  previewUrl: string;
}

interface ProjectDetailProps {
  projectId: string;
  initialName: string;
  sessions: SessionRow[];
  savedReferences: SavedRow[];
}

export function ProjectDetail({
  projectId,
  initialName,
  sessions: initialSessions,
  savedReferences: initialSaved,
}: ProjectDetailProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialName);
  const [sessions] = useState(initialSessions);
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);

  // One active shortlist row uses the shared AB transport (reference-only).
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  function selectReference(referenceId: string) {
    if (activeId === referenceId) {
      setPlaying((prev) => !prev);
      return;
    }
    setActiveId(referenceId);
    setPlaying(true);
  }

  async function handleRename() {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error("Enter a name");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error ?? "Could not rename");
      }
      setName(trimmed);
      setEditing(false);
      toast.success("Project renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete project “${name}”? Sessions stay in History.`)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error ?? "Could not delete");
      }
      toast.message("Project deleted");
      router.push("/projects");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete");
      setBusy(false);
    }
  }

  async function handleUnsave(referenceTrackId: string) {
    try {
      const response = await fetch(`/api/projects/${projectId}/saved`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceTrackId }),
      });
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error ?? "Could not remove");
      }
      setSaved((current) =>
        current.filter((row) => row.id !== referenceTrackId),
      );
      if (activeId === referenceTrackId) {
        setPlaying(false);
        setActiveId(null);
      }
      toast.message("Removed from shortlist");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove");
    }
  }

  const activeRef = saved.find((row) => row.id === activeId) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        {editing ? (
          <div className="flex flex-wrap gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="max-w-md"
              maxLength={120}
              disabled={busy}
            />
            <Button onClick={handleRename} disabled={busy} size="sm">
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(name);
                setEditing(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
              {name}
            </h1>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
                disabled={busy}
              >
                Rename
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDelete}
                disabled={busy}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
        <p className="text-sm text-text-secondary">
          Sessions in this job and your saved commercial references.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-text-primary">Sessions</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-text-muted">
            No sessions assigned yet. Pick this project when analyzing, or
            assign from a session after starring a reference.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}?from=${encodeURIComponent(`/projects/${projectId}`)}`}
                  className="group list-row-hover flex items-center gap-4 rounded-xl border border-border bg-surface-1 px-5 py-5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-base font-medium tracking-tight text-text-primary group-hover:text-client">
                      {session.title}
                    </span>
                    <span className="font-mono text-xs text-text-muted">
                      {formatSessionDate(session.createdAt)} ·{" "}
                      {session.matchCount} ref
                      {session.matchCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ChevronRightIcon
                    className="size-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-client"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-text-primary">
          Saved references
        </h2>
        {saved.length === 0 ? (
          <p className="text-sm text-text-muted">
            Star references from a match session to build this shortlist.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {saved.map((ref) => {
              const isActive = activeId === ref.id;
              return (
                <li
                  key={ref.savedId}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border border-border bg-surface-1 px-4 py-3",
                    isActive && "ring-1 ring-reference/40",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => selectReference(ref.id)}
                      aria-label={
                        isActive && playing
                          ? `Pause ${ref.title}`
                          : `Play ${ref.title}`
                      }
                      className="relative size-14 shrink-0 overflow-hidden rounded-md"
                    >
                      {ref.artworkUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- iTunes CDN artwork, same as carousel
                        <img
                          src={ref.artworkUrl}
                          alt=""
                          width={56}
                          height={56}
                          className="size-14 object-cover"
                        />
                      ) : (
                        <div className="size-14 bg-surface-2" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {ref.title}
                      </p>
                      <p className="truncate text-xs text-text-muted">
                        {ref.artist}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => selectReference(ref.id)}
                    >
                      {isActive && playing ? "Pause" : "Play"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleUnsave(ref.id)}
                    >
                      Remove
                    </Button>
                  </div>

                  {isActive && activeRef && (
                    <ABPlayer
                      key={activeRef.id}
                      clientUrl={null}
                      referenceUrl={activeRef.previewUrl}
                      playing={playing}
                      onPlayingChange={setPlaying}
                      layout="compact"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
