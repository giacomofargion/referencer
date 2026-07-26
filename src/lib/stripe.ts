import Stripe from "stripe";

let stripeClient: Stripe | null = null;

/** Pinned to the version shipped with the installed `stripe` package. */
const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2026-06-24.dahlia";

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key, {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return stripeClient;
}
