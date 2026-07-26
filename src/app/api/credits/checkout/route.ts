import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { creditPriceCents } from "@/lib/credits";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

const MAX_QUANTITY = 100;

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Payments are not configured on this server" },
      { status: 503 },
    );
  }

  let quantity = 1;
  try {
    const body = (await request.json()) as { quantity?: unknown };
    if (typeof body.quantity === "number" && Number.isInteger(body.quantity)) {
      quantity = body.quantity;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (quantity < 1 || quantity > MAX_QUANTITY) {
    return NextResponse.json(
      { error: `quantity must be between 1 and ${MAX_QUANTITY}` },
      { status: 400 },
    );
  }

  const origin = new URL(request.url).origin;
  const unitAmount = creditPriceCents();
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${origin}/?credits=success`,
    cancel_url: `${origin}/?credits=canceled`,
    client_reference_id: userId,
    metadata: {
      clerk_user_id: userId,
      credit_quantity: String(quantity),
    },
    line_items: [
      {
        quantity,
        price_data: {
          currency: "gbp",
          unit_amount: unitAmount,
          product_data: {
            name: "Similarity search credit",
            description: "1 credit = 1 Cyanite similarity search",
          },
        },
      },
    ],
  });

  if (!session.url) {
    return NextResponse.json(
      { error: "Could not create checkout session" },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: session.url });
}
