<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

Product: a single Next.js 16 (App Router, Turbopack) app — "Tonemap" — that matches an unmastered mix to commercial reference tracks. The frontend and all backend logic (API route handlers in `src/app/api/*`) live in the same Next.js process. The Python MERT worker in `workers/mert-embed/` is experimental and NOT wired into the app; skip it unless you are specifically experimenting with it.

Run / lint / test / build (dependencies + `public/` model assets are already provided by the startup update script):
- Dev server: `npm run dev` (port 3000). This is the command to use for development.
- Lint: `npm run lint` (ESLint). There is no separate type-check script — types are checked during `npm run build`.
- Unit tests: there is no `npm test` script. Tests use Node's built-in runner via `tsx`: `npx tsx --test src/lib/*.test.ts`. They are pure (no network/DB).
- Build: `npm run build` (its `prebuild` re-vendors TF.js + Discogs weights).

Non-obvious gotchas:
- Auth (Clerk) works with NO keys: `@clerk/nextjs` runs in "keyless mode" and auto-provisions an ephemeral dev instance (stored in gitignored `.clerk/`), so pages render and the app boots without any `CLERK_*` env vars. BUT automated/headless sign-up is blocked by Clerk's Cloudflare Turnstile CAPTCHA. To exercise authenticated flows, either complete sign-up manually in a real browser, or set real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` for an instance with bot protection disabled (Clerk test emails use the `+clerk_test` suffix with verification code `424242`).
- Database is a hard requirement: `src/lib/db.ts` throws at import if `DATABASE_URL` is empty, so every API route that imports it (and `next build`) fails without it. A syntactically valid placeholder (e.g. `postgresql://u:p@localhost:5432/db`) is enough to let dev/build boot, but real queries need a real endpoint.
- The DB driver is `@neondatabase/serverless`, which speaks Neon's SQL-over-HTTP protocol only — it CANNOT connect to a plain local Postgres without changing app code (`neonConfig`). Use a real Neon connection string for DB-backed testing.
- Missing base migration: `scripts/migrations/` starts at `001`, which `ALTER`s `client_uploads` and references `reference_tracks` — but no migration creates those base tables. A brand-new empty Neon database will NOT have the full schema. Use a Neon DB that already has these tables (e.g. the existing dev/prod DB) for upload → match / projects / credits flows.
- External keyless APIs: discovery calls Deezer + iTunes public search APIs (no keys, needs outbound internet). Stripe and Cloudflare R2 are optional and degrade gracefully when their env vars are unset.
- Model assets in `public/models/discogs-genre/` and `public/vendor/tf.min.js` are gitignored and fetched by `npm run models:discogs`; they must exist for in-browser genre tagging.
