/**
 * Clerk UI themed to match our dark-studio tokens.
 * Uses the same surface / client / text colors so auth doesn't feel like another product.
 */
export const clerkAppearance = {
  variables: {
    colorBackground: "oklch(0.2 0.012 250)",
    colorInputBackground: "oklch(0.15 0.01 250)",
    colorInputText: "oklch(0.95 0.005 250)",
    colorText: "oklch(0.95 0.005 250)",
    colorTextSecondary: "oklch(0.72 0.01 250)",
    colorPrimary: "oklch(0.82 0.15 175)",
    colorDanger: "oklch(0.65 0.2 25)",
    colorNeutral: "oklch(0.72 0.01 250)",
    borderRadius: "0.5rem",
    fontFamily: "var(--font-geist-sans)",
  },
  elements: {
    card: "bg-surface-1 border border-border shadow-none",
    headerTitle: "text-text-primary",
    headerSubtitle: "text-text-secondary",
    socialButtonsBlockButton:
      "bg-surface-2 border border-border text-text-primary hover:bg-surface-2",
    formButtonPrimary:
      "bg-client text-client-foreground hover:bg-client/90 shadow-none",
    footerActionLink: "text-client hover:text-client/80",
  },
} as const;
