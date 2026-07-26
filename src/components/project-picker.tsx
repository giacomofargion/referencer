"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

interface ProjectPickerProps {
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
}

const NONE_VALUE = "__none__";

/** Optional project assignment before analyzing a client track. */
export function ProjectPicker({
  value,
  onChange,
  disabled,
}: ProjectPickerProps) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) return;
        const data = (await response.json()) as { projects: ProjectOption[] };
        if (!cancelled) setProjects(data.projects);
      } catch {
        // Picker is optional — ignore load failures.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error("Enter a project name");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error ?? "Could not create project");
      }
      const data = (await response.json()) as { project: ProjectOption };
      setProjects((prev) => [data.project, ...prev]);
      onChange(data.project.id);
      setNewName("");
      setCreating(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create project",
      );
    } finally {
      setBusy(false);
    }
  }

  const selectedLabel =
    value === null
      ? "No project"
      : (projects.find((project) => project.id === value)?.name ?? "No project");

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-text-muted">
        Project <span className="text-text-muted/70">(optional)</span>
      </label>
      {creating ? (
        <div className="flex flex-wrap gap-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Project name"
            disabled={disabled || busy}
            className="min-w-[12rem] flex-1"
            maxLength={120}
          />
          <Button
            type="button"
            size="sm"
            onClick={handleCreate}
            disabled={disabled || busy}
          >
            Create
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={value ?? NONE_VALUE}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              onChange(next === NONE_VALUE ? null : next);
            }}
            disabled={disabled}
          >
            <SelectTrigger className="w-56">
              {/* Base UI falls back to the raw value (UUID) without an explicit label. */}
              <SelectValue placeholder="No project">
                {selectedLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setCreating(true)}
            disabled={disabled}
          >
            New project
          </Button>
        </div>
      )}
    </div>
  );
}
