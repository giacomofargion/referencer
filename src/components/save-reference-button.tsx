"use client";

import { useState } from "react";
import { StarIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AssignProjectDialog,
  type ProjectOption,
} from "@/components/assign-project-dialog";
import { Button } from "@/components/ui/button";

interface SaveReferenceButtonProps {
  referenceTrackId: string;
  saved: boolean;
  uploadId: string;
  projectId: string | null;
  onProjectAssigned: (project: ProjectOption) => void;
  onSavedChange: (saved: boolean) => void;
}

/** Star / unstar a commercial reference onto the session's project shortlist. */
export function SaveReferenceButton({
  referenceTrackId,
  saved,
  uploadId,
  projectId,
  onProjectAssigned,
  onSavedChange,
}: SaveReferenceButtonProps) {
  const [busy, setBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);

  async function toggleSave(activeProjectId: string) {
    setBusy(true);
    try {
      if (saved) {
        const response = await fetch(`/api/projects/${activeProjectId}/saved`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referenceTrackId }),
        });
        if (!response.ok) {
          const { error } = await response.json();
          throw new Error(error ?? "Could not unsave");
        }
        onSavedChange(false);
        toast.message("Removed from project shortlist");
      } else {
        const response = await fetch(`/api/projects/${activeProjectId}/saved`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referenceTrackId }),
        });
        if (!response.ok) {
          const { error } = await response.json();
          throw new Error(error ?? "Could not save");
        }
        onSavedChange(true);
        toast.success("Saved to project shortlist");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  }

  function handleClick() {
    if (!projectId) {
      setPendingSave(true);
      setAssignOpen(true);
      return;
    }
    void toggleSave(projectId);
  }

  return (
    <>
      <Button
        type="button"
        variant={saved ? "default" : "outline"}
        size="sm"
        disabled={busy}
        onClick={handleClick}
        aria-pressed={saved}
        className="gap-1.5"
      >
        <StarIcon
          className={`size-3.5 ${saved ? "fill-current" : ""}`}
          aria-hidden
        />
        {saved ? "Saved" : "Save"}
      </Button>

      <AssignProjectDialog
        open={assignOpen}
        onOpenChange={(open) => {
          setAssignOpen(open);
          if (!open) setPendingSave(false);
        }}
        uploadId={uploadId}
        onAssigned={(project) => {
          onProjectAssigned(project);
          if (pendingSave) {
            setPendingSave(false);
            void toggleSave(project.id);
          }
        }}
      />
    </>
  );
}
