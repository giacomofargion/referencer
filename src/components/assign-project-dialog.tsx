"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ProjectOption {
  id: string;
  name: string;
}

interface AssignProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uploadId: string;
  onAssigned: (project: ProjectOption) => void;
}

/**
 * When starring a ref without a project, create or pick one and attach
 * the current session first.
 */
export function AssignProjectDialog({
  open,
  onOpenChange,
  uploadId,
  onAssigned,
}: AssignProjectDialogProps) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"pick" | "create">("pick");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error("Could not load projects");
        const data = (await response.json()) as {
          projects: ProjectOption[];
        };
        if (cancelled) return;
        setProjects(data.projects);
        setMode(data.projects.length === 0 ? "create" : "pick");
        setSelectedId(data.projects[0]?.id ?? "");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not load projects",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleConfirm() {
    setBusy(true);
    try {
      let project: ProjectOption;
      if (mode === "create") {
        const name = newName.trim();
        if (!name) {
          toast.error("Enter a project name");
          return;
        }
        const createResponse = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!createResponse.ok) {
          const { error } = await createResponse.json();
          throw new Error(error ?? "Could not create project");
        }
        const created = (await createResponse.json()) as {
          project: ProjectOption;
        };
        project = created.project;
      } else {
        const picked = projects.find((p) => p.id === selectedId);
        if (!picked) {
          toast.error("Pick a project");
          return;
        }
        project = picked;
      }

      const assignResponse = await fetch(`/api/sessions/${uploadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (!assignResponse.ok) {
        const { error } = await assignResponse.json();
        throw new Error(error ?? "Could not assign project");
      }

      onAssigned(project);
      onOpenChange(false);
      setNewName("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-surface-1 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save to a project</DialogTitle>
          <DialogDescription>
            Saved references live on a project (client job). Create one or pick
            an existing project for this session.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {projects.length > 0 && (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "pick" ? "default" : "outline"}
                onClick={() => setMode("pick")}
              >
                Existing
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "create" ? "default" : "outline"}
                onClick={() => setMode("create")}
              >
                New project
              </Button>
            </div>
          )}

          {mode === "pick" && projects.length > 0 ? (
            <Select
              value={selectedId}
              onValueChange={(next) => {
                if (typeof next === "string") setSelectedId(next);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose project">
                  {projects.find((project) => project.id === selectedId)
                    ?.name ?? "Choose project"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="e.g. Nova — single mix"
              maxLength={120}
              autoFocus
            />
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
