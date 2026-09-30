"use client";

import { useState } from "react";
import { FlagIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

interface RejectMatchButtonProps {
  referenceTrackId: string;
  uploadId: string;
  /** Caller fires the actual feedback POST — this component stays free of
   * feedback-computation logic, mirroring SaveReferenceButton's onSavedChange. */
  onReported: () => Promise<void> | void;
}

/** One-shot "not a good match" signal — no undo, no project-assignment dialog. */
export function RejectMatchButton({
  referenceTrackId,
  uploadId,
  onReported,
}: RejectMatchButtonProps) {
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      await onReported();
      setReported(true);
      toast.message("Thanks — noted as not a good match");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy || reported}
      onClick={() => void handleClick()}
      aria-label={`Report reference ${referenceTrackId} for upload ${uploadId} as not a good match`}
      className="gap-1.5"
    >
      <FlagIcon className="size-3.5" aria-hidden />
      {reported ? "Reported" : "Not a good match"}
    </Button>
  );
}
