import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";

import { clerkAppearance } from "@/lib/clerk-appearance";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={{ theme: shadcn, ...clerkAppearance }}>
      {children}
    </ClerkProvider>
  );
}
