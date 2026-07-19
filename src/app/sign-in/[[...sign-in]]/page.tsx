import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-surface-0 px-6 py-16">
      <SignIn />
    </main>
  );
}
