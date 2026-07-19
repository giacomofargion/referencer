import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-surface-0 px-6 py-16">
      <SignUp />
    </main>
  );
}
