# Referencer

**Find commercial reference tracks that actually match an unmastered mix.**

Referencer helps mastering engineers skip the “what should I A/B against?” search. Upload a client track, get a ranked shortlist of released songs in a similar sonic ballpark — loudness, frequency balance, dynamics, tempo, and stereo width — with plain-English reasons and instant A/B playback.

Built as a full-stack product demo: real audio analysis in the browser and on the server, similarity ranking you can inspect, and a workflow aimed at studio practice rather than a generic AI toy.

---

## Why it exists

Picking reference tracks is slow and subjective. Engineers often jump between streaming apps, playlists, and memory. Referencer turns that into a measurable pipeline:

1. Analyze the upload (client-side WASM)
2. Discover sonically related commercial tracks (Cyanite → Spotify)
3. Hydrate metadata + 30s previews (iTunes Search)
4. Cache feature vectors in Postgres and re-rank with adjustable weight presets
5. Present matches with EQ-style meters and synchronized A/B listening

---

## What this project demonstrates

| Area                   | Implementation                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Client audio ML**    | Essentia.js (WASM) in a Web Worker — LUFS, LRA, 7-band balance, BPM, stereo width, onsets                              |
| **Similarity ranking** | Weighted multi-feature distance with tone / loudness / balanced presets; client-side re-rank without a second API call |
| **External APIs**      | Cyanite (similar-track discovery), iTunes Search (previews + metadata), Spotify oEmbed                                 |
| **Backend**            | Next.js Route Handlers with Clerk auth, Neon Postgres feature cache, optional Cloudflare R2 uploads                    |
| **UX**                 | Upload → analyze → match flow, match carousel, EQ curve visuals, A/B player for engineer review                        |
| **Product craft**      | Auth-gated app, webhook + polling for async analysis, env-driven integrations                                          |

---

## Stack

- **Framework:** Next.js (App Router) · React 19 · TypeScript
- **UI:** Tailwind CSS v4 · shadcn/ui · Motion
- **Auth:** Clerk
- **Data:** Neon Postgres · Cloudflare R2 (optional object storage)
- **Audio:** Essentia.js (WASM) · server-side preview analysis via `node-web-audio-api`
- **Discovery:** Cyanite.ai · iTunes Search API · Spotify oEmbed

---

## Architecture

```
┌─────────────┐     analyze (WASM worker)      ┌──────────────────┐
│  Browser    │ ─────────────────────────────► │  Feature vector  │
│  Upload UI  │                                └────────┬─────────┘
└──────┬──────┘                                         │
       │ multipart + features                           │
       ▼                                                ▼
┌─────────────┐   Cyanite similar tracks    ┌──────────────────────┐
│  /api/match │ ──────────────────────────► │  Spotify candidates  │
└──────┬──────┘                             └──────────┬───────────┘
       │                                               │
       │ iTunes hydrate + preview analyze              │
       ▼                                               ▼
┌─────────────┐                             ┌──────────────────────┐
│ Neon cache  │ ◄──── feature vectors ───── │ Rank + explain       │
└─────────────┘                             │ Top matches → client │
                                            └──────────────────────┘
```

**Pipeline in practice**

1. Sign in → upload an unmastered track
2. Browser runs Essentia analysis off the main thread
3. `/api/match` sends audio to Cyanite for similar Spotify tracks
4. Candidates are resolved to iTunes previews, analyzed server-side, and cached in Neon
5. Results return ranked with human-readable deltas; the client can re-weight tone vs loudness live

---

## Project structure

```
src/
  app/api/          # uploads, match pipeline, Cyanite webhook
  components/       # upload flow, match UI, A/B player, EQ graphs
  lib/              # analysis, ranking, Cyanite, iTunes, R2, DB
public/
  essentia/         # WASM runtime for in-browser analysis
  workers/          # analysis Web Worker
```
