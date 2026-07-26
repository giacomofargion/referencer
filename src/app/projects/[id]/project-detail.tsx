"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PauseIcon, PlayIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSessionDate } from "@/lib/format";

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

  // One shared audio element so only one preview plays at a time.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
    };
  }, []);

  function togglePreview(referenceId: string, previewUrl: string) {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === referenceId) {
      audio.pause();
      setPlayingId(null);
      return;
    }

    audio.src = previewUrl;
    void audio
      .play()
      .then(() => setPlayingId(referenceId))
      .catch((error: unknown) => {
        // Rapid track switches abort the previous play() — ignore those.
        if (
          (error instanceof DOMException || error instanceof Error) &&
          error.name === "AbortError"
        ) {
          return;
        }
        toast.error("Couldn't play this preview");
      });
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
      if (playingId === referenceTrackId) {
        audioRef.current?.pause();
        setPlayingId(null);
      }
      toast.message("Removed from shortlist");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove");
    }
  }

  return (
    <div className="flex flex-col gap-10">
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
        <h2 className="text-lg font-semibold text-text-primary">Sessions</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-text-muted">
            No sessions assigned yet. Pick this project when analyzing, or
            assign from a session after starring a reference.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border-y border-border">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  className="flex flex-col gap-1 py-3 transition-colors hover:bg-surface-1/60 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="font-medium text-text-primary">
                    {session.title}
                  </span>
                  <span className="font-mono text-xs text-text-muted">
                    {formatSessionDate(session.createdAt)} ·{" "}
                    {session.matchCount} refs
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-text-primary">
          Saved references
        </h2>
        {saved.length === 0 ? (
          <p className="text-sm text-text-muted">
            Star references from a match session to build this shortlist.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            <audio
              ref={audioRef}
              preload="none"
              onEnded={() => setPlayingId(null)}
            />
            {saved.map((ref) => {
              const isPlaying = playingId === ref.id;
              return (
                <li
                  key={ref.savedId}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={() => togglePreview(ref.id, ref.previewUrl)}
                    aria-label={
                      isPlaying
                        ? `Pause ${ref.title} preview`
                        : `Play ${ref.title} preview`
                    }
                    className="group relative size-14 shrink-0 overflow-hidden rounded-md"
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
                    <span className="absolute inset-0 flex items-center justify-center bg-surface-0/55">
                      <span className="flex size-8 items-center justify-center rounded-full bg-surface-0/90 text-text-primary ring-1 ring-border">
                        {isPlaying ? (
                          <PauseIcon className="size-3.5" />
                        ) : (
                          <PlayIcon className="size-3.5 translate-x-px" />
                        )}
                      </span>
                    </span>
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
                    onClick={() => togglePreview(ref.id, ref.previewUrl)}
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleUnsave(ref.id)}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
