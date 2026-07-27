import { SignIn } from "@clerk/nextjs";

import { AppHeader } from "@/components/app-header";

export default function SignInPage() {
  return (
    <>
      <AppHeader brandOnly />
      <main className="flex flex-1 items-center justify-center bg-surface-0 px-6 py-16">
        <SignIn />
      </main>
    </>
  );
}
