/**
 * Owner accounts get unlimited free matches (no credit spend).
 * Set OWNER_CLERK_USER_ID or comma-separated OWNER_CLERK_USER_IDS in env.
 */
export function isOwnerUser(clerkUserId: string): boolean {
  const raw =
    process.env.OWNER_CLERK_USER_IDS?.trim() ||
    process.env.OWNER_CLERK_USER_ID?.trim() ||
    "";
  if (!raw) return false;
  const allowed = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowed.includes(clerkUserId);
}
