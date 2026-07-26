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
          <p className="max-w-xl mb-5 text-sm leading-relaxed text-text-secondary">
            Upload an unmastered client track. We meter loudness, frequency
            balance, dynamics, tempo, and stereo width, then use Cyanite.ai to find
            sonically similar commercial releases on Spotify — ranked against
            your mix so you have a concrete shortlist to A/B.
          </p>
        </div>

        <UploadCard />
      </main>
    </>
  );
}
