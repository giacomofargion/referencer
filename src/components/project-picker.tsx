"use client";

import { useEffect, useId, useMemo, useState } from "react";
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
  /**
   * When a project was assigned outside this picker (e.g. save dialog),
   * pass it so the label/options stay correct before a refetch lands.
   */
  knownOption?: ProjectOption | null;
}

const NONE_VALUE = "__none__";

async function fetchProjects(): Promise<ProjectOption[]> {
  const response = await fetch("/api/projects");
  if (!response.ok) return [];
  const data = (await response.json()) as { projects: ProjectOption[] };
  return data.projects;
}

/** Optional project assignment before analyzing a client track. */
export function ProjectPicker({
  value,
  onChange,
  disabled,
  knownOption = null,
}: ProjectPickerProps) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const projectFieldId = useId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchProjects();
        if (!cancelled) setProjects(next);
      } catch {
        // Picker is optional — ignore load failures.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One-time mount list can miss projects assigned via the save dialog.
  useEffect(() => {
    if (value === null) return;
    if (projects.some((project) => project.id === value)) return;
    if (knownOption?.id === value) return;

    let cancelled = false;
    (async () => {
      try {
        const next = await fetchProjects();
        if (!cancelled) setProjects(next);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, projects, knownOption]);

  const options = useMemo(() => {
    if (!knownOption) return projects;
    if (projects.some((project) => project.id === knownOption.id)) {
      return projects;
    }
    return [knownOption, ...projects];
  }, [projects, knownOption]);

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
      : (options.find((project) => project.id === value)?.name ??
        (knownOption?.id === value ? knownOption.name : null) ??
        "No project");

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={projectFieldId} className="text-xs text-text-muted">
        Project <span className="text-text-muted/70">(optional)</span>
      </label>
      {creating ? (
        <div className="flex flex-wrap gap-2">
          <Input
            id={projectFieldId}
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
            <SelectTrigger id={projectFieldId} className="w-56">
              {/* Base UI falls back to the raw value (UUID) without an explicit label. */}
              <SelectValue placeholder="No project">
                {selectedLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No project</SelectItem>
              {options.map((project) => (
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
