import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { UploadCard } from "@/components/upload-card";

export default function Home() {
  return (
    <>
      <AppHeader />
      <PageShell>
        <div className="flex flex-col gap-3">
          <h1 className="text-hero-gradient text-3xl font-semibold tracking-tight">
            Find a reference track
          </h1>
          <p className="max-w-xl text-sm mb-4 leading-relaxed text-text-secondary">
            Upload a mix. We match it to commercial releases you can A/B against
            your track.
          </p>
        </div>

        <UploadCard />
      </PageShell>
    </>
  );
}
