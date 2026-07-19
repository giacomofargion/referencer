import { AppHeader } from "@/components/app-header";
import { UploadCard } from "@/components/upload-card";

export default function Home() {
  return (
    <>
      <AppHeader />
      {/* Backdrop lighting behind all content; pointer-events-none keeps it inert */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px]"
      >
        <div className="grid-texture absolute inset-0" />
        <div className="hero-glow absolute inset-0" />
      </div>
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
        <div className="flex flex-col gap-3">
          <h1 className="text-hero-gradient text-3xl font-semibold tracking-tight">
            Find a reference track
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-text-secondary">
            Upload an unmastered client track. We analyze loudness, frequency
            balance, dynamics, tempo, and stereo width, then return released
            tracks in a similar sonic ballpark — a fast starting point to find a reference.
          </p>
        </div>

        <UploadCard />
      </main>
    </>
  );
}
