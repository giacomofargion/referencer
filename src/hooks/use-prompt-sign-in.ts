"use client";

import { useCallback } from "react";
import { useClerk } from "@clerk/nextjs";
import { toast } from "sonner";

/** Same soft-gate UX used for analyze / project create when signed out. */
export function usePromptSignIn() {
  const { openSignIn } = useClerk();

  return useCallback(() => {
    toast.message(
      "Sign in to find references — new accounts get 5 free credits.",
    );
    openSignIn({});
  }, [openSignIn]);
}

/** Only real auth failures — not HTML 500 pages from crashed API routes. */
export function isUnauthenticatedResponse(response: Response): boolean {
  return response.status === 401 || response.redirected;
}

/**
 * Safely read JSON from an API response. Returns a clear error when the
 * server sent HTML (auth redirect, gateway timeout page, etc.).
 */
export async function readApiJson<T>(
  response: Response,
): Promise<
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      unauthenticated: boolean;
      error: string;
      code?: string;
    }
> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const unauthenticated = isUnauthenticatedResponse(response);
    return {
      ok: false,
      status: response.status,
      unauthenticated,
      error: unauthenticated
        ? "Please sign in to continue"
        : `Server error (${response.status || "unknown"})`,
    };
  }

  const data = (await response.json()) as T & {
    error?: string;
    code?: string;
  };

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      unauthenticated: response.status === 401,
      error: data.error ?? `Request failed (${response.status})`,
      code: data.code,
    };
  }

  return { ok: true, data };
}
