/**
 * Clerk UI themed to Tonemap's dark-studio tokens.
 * Applied via ClerkProvider so modal + dedicated sign-in/up pages stay consistent.
 */
/** Shared avatar chrome — quiet surface fill, soft inset ring, no Clerk shimmer. */
const avatarChrome =
  "overflow-hidden rounded-full bg-surface-2 shadow-none ring-1 ring-inset ring-border/50";

export const clerkAppearance = {
  // Tailwind utilities in `elements` must win over Clerk's emotion styles.
  cssLayerName: "clerk",
  options: {
    logoLinkUrl: "/",
    socialButtonsVariant: "blockButton" as const,
  },
  variables: {
    // Prefer explicit oklch values — Clerk's color-mix pipeline is happier than
    // nesting var(--token) through every derived shade.
    colorPrimary: "oklch(0.79 0.17 175)",
    colorPrimaryForeground: "oklch(0.14 0.03 175)",
    colorDanger: "oklch(0.65 0.2 25)",
    colorSuccess: "oklch(0.75 0.14 155)",
    colorWarning: "oklch(0.78 0.15 70)",
    colorNeutral: "oklch(0.68 0.008 250)",
    colorForeground: "oklch(0.97 0.003 250)",
    colorMutedForeground: "oklch(0.68 0.008 250)",
    colorMuted: "oklch(0.17 0.01 250)",
    colorBackground: "oklch(0.13 0.009 250)",
    colorInput: "oklch(0.09 0.008 250)",
    colorInputForeground: "oklch(0.97 0.003 250)",
    colorBorder: "oklch(1 0 0 / 7%)",
    colorRing: "oklch(0.79 0.17 175)",
    colorShadow: "oklch(0 0 0 / 55%)",
    // Disable the purple hover sweep on avatars; keep chrome static and studio-quiet.
    colorShimmer: "oklch(0.17 0.01 250 / 0%)",
    colorModalBackdrop: "oklch(0.06 0.008 250 / 78%)",
    borderRadius: "0.5rem",
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    fontSize: "0.875rem",
  },
  elements: {
    // w-fit so page layouts with justify-center can actually center the card
    // (Clerk's default rootBox stretches full width and leaves the card left-aligned).
    rootBox: "mx-auto w-fit font-sans",
    card: "bg-surface-1 border border-border shadow-none",
    cardBox: "shadow-none",
    modalContent: "bg-surface-1 border border-border shadow-none",
    modalCloseButton:
      "text-text-muted hover:text-text-primary hover:bg-surface-2",
    headerTitle: "text-text-primary tracking-tight",
    headerSubtitle: "text-text-secondary",
    logoBox: "hidden",
    logoImage: "hidden",
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
    avatarBox: avatarChrome,
    avatarImage: "object-cover",
    userButtonTrigger:
      "rounded-full p-0 shadow-none outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-client/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0",
    userButtonAvatarBox: `${avatarChrome} size-8 border border-border`,
    userButtonAvatarImage: "object-cover",
    userButtonPopoverCard: "bg-surface-1 border border-border shadow-none",
    userButtonPopoverActionButton:
      "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
    userButtonPopoverActionButtonIcon: "text-text-muted",
    userButtonPopoverFooter: "hidden",
  },
} as const;
