import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { creditFromPurchase } from "@/lib/credits";
import { getStripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET is not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await request.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    console.error("Stripe webhook signature failed:", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const clerkUserId =
      session.metadata?.clerk_user_id ?? session.client_reference_id;
    const quantity = Number.parseInt(
      session.metadata?.credit_quantity ?? "0",
      10,
    );

    if (!clerkUserId || !Number.isFinite(quantity) || quantity < 1) {
      console.error("Stripe webhook missing credit metadata", {
        sessionId: session.id,
        metadata: session.metadata,
      });
      return NextResponse.json({ error: "Invalid session metadata" }, { status: 400 });
    }

    // Only credit successful paid sessions (ignore unpaid/async failures).
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      console.info("Stripe webhook ignored unpaid session", session.id);
      return NextResponse.json({ received: true });
    }

    await creditFromPurchase({
      clerkUserId,
      quantity,
      stripeSessionId: session.id,
    });
  }

  return NextResponse.json({ received: true });
}
