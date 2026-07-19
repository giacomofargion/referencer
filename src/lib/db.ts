import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

/**
 * Tagged-template SQL client (HTTP-based, suited to serverless).
 * Usage: await sql`SELECT * FROM reference_tracks WHERE genre = ${genre}`
 */
export const sql = neon(process.env.DATABASE_URL);
