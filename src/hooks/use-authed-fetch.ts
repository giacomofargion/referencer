"use client";

import { useCallback } from "react";
import { useAuth } from "@clerk/nextjs";

/**
 * Same-origin fetch that attaches the Clerk session JWT.
 * Needed when the browser has a client session but the server cookie
 * handshake hasn't attached yet (common right after custom-domain cutover).
 */
export function useAuthedFetch() {
  const { getToken } = useAuth();

  return useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const token = await getToken();
      const headers = new Headers(init?.headers);
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      return fetch(input, { ...init, headers });
    },
    [getToken],
  );
}
