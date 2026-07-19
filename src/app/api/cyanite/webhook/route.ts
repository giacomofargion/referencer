import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

/**
 * Optional Cyanite webhook. Local/portfolio flows poll analysis status instead,
 * but registering this URL in the Cyanite dashboard lets you receive TEST events
 * and finished notifications when the app is publicly reachable.
 *
 * Docs: https://api-docs.cyanite.ai/docs/listening-to-webhook-events
 */
export async function POST(request: Request) {
  const secret = process.env.CYANITE_WEBHOOK_SECRET?.trim();
  const rawBody = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get("signature") ?? request.headers.get("Signature");

  // Dashboard "send test event" omits the Signature header.
  if (secret && signature) {
    try {
      verifyCyaniteSignature(secret, signature, rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else if (secret && !signature) {
    // Allow unsigned test pings so integration setup works.
    console.info("Cyanite webhook: unsigned body (likely dashboard test event)");
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 422 });
  }

  console.info("Cyanite webhook:", JSON.stringify(payload));
  // Respond within Cyanite's 3s limit — heavy work stays on the match poller.
  return NextResponse.json({ ok: true });
}

function verifyCyaniteSignature(
  secret: string,
  signature: string,
  body: Buffer,
): void {
  const hmac = createHmac("sha512", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("bad signature");
  }
}
