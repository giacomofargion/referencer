/**
 * Clerk UI themed to Tonemap's dark-studio tokens.
 * Applied via ClerkProvider so modal + dedicated sign-in/up pages stay consistent.
 */
export const clerkAppearance = {
  options: {
    logoImageUrl: "/tonemap-mark.svg",
    logoLinkUrl: "/",
    socialButtonsVariant: "blockButton" as const,
  },
  variables: {
    // Prefer explicit oklch values — Clerk's color-mix pipeline is happier than
    // nesting var(--token) through every derived shade.
    colorPrimary: "oklch(0.82 0.15 175)",
    colorPrimaryForeground: "oklch(0.16 0.02 175)",
    colorDanger: "oklch(0.65 0.2 25)",
    colorSuccess: "oklch(0.75 0.14 155)",
    colorWarning: "oklch(0.8 0.14 70)",
    colorNeutral: "oklch(0.72 0.01 250)",
    colorForeground: "oklch(0.95 0.005 250)",
    colorMutedForeground: "oklch(0.72 0.01 250)",
    colorMuted: "oklch(0.26 0.014 250)",
    colorBackground: "oklch(0.2 0.012 250)",
    colorInput: "oklch(0.15 0.01 250)",
    colorInputForeground: "oklch(0.95 0.005 250)",
    colorBorder: "oklch(1 0 0 / 12%)",
    colorRing: "oklch(0.82 0.15 175)",
    colorShadow: "oklch(0 0 0 / 45%)",
    colorModalBackdrop: "oklch(0.1 0.01 250 / 72%)",
    borderRadius: "0.5rem",
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    fontSize: "0.875rem",
  },
  elements: {
    rootBox: "font-sans",
    card: "bg-surface-1 border border-border shadow-none",
    cardBox: "shadow-none",
    modalContent: "bg-surface-1 border border-border shadow-none",
    modalCloseButton:
      "text-text-muted hover:text-text-primary hover:bg-surface-2",
    headerTitle: "text-text-primary tracking-tight",
    headerSubtitle: "text-text-secondary",
    logoBox: "justify-center",
    logoImage: "size-9 rounded-lg",
    socialButtonsBlockButton:
      "bg-surface-2 border border-border text-text-primary hover:bg-surface-2/80 shadow-none",
    socialButtonsBlockButtonText: "text-text-primary font-medium",
    dividerLine: "bg-border",
    dividerText: "text-text-muted",
    formFieldLabel: "text-text-secondary",
    formFieldInput:
      "bg-surface-0 border-border text-text-primary placeholder:text-text-muted focus:border-client focus:ring-client/40",
    formButtonPrimary:
      "bg-client text-client-foreground hover:bg-client/90 shadow-none font-medium",
    formButtonReset: "text-text-secondary hover:text-text-primary",
    footer: "bg-transparent",
    footerActionText: "text-text-muted",
    footerActionLink: "text-client hover:text-client/80",
    identityPreviewEditButton: "text-client hover:text-client/80",
    formFieldSuccessText: "text-text-secondary",
    formFieldErrorText: "text-destructive",
    alertText: "text-text-secondary",
    otpCodeFieldInput: "bg-surface-0 border-border text-text-primary",
    userButtonPopoverCard: "bg-surface-1 border border-border shadow-none",
    userButtonPopoverActionButton:
      "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
    userButtonPopoverFooter: "hidden",
  },
} as const;
