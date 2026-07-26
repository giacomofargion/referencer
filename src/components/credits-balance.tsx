"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAuthedFetch } from "@/hooks/use-authed-fetch";

const PACKS = [1, 5, 10, 20, 50] as const;
const MAX_QUANTITY = 100;
const BUY_EVENT = "tonemap:buy-credits";

interface BalancePayload {
  balance: number;
  creditPriceCents: number;
  freeStarterCredits: number;
}

function formatGbp(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

export function CreditsBalance() {
  const authedFetch = useAuthedFetch();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BalancePayload | null>(null);
  const [quantity, setQuantity] = useState(5);
  const [customValue, setCustomValue] = useState("5");
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await authedFetch("/api/credits/balance");
      if (!response.ok) return;
      const payload = (await response.json()) as BalancePayload;
      if (!cancelled) setData(payload);
    })();
    return () => {
      cancelled = true;
    };
  }, [authedFetch]);

  // Deep-link + post-checkout feedback via query params (no /credits page).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shouldOpenBuy = params.get("buy") === "1";
    const creditsStatus = params.get("credits");

    if (params.has("buy") || params.has("credits")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("buy");
      url.searchParams.delete("credits");
      window.history.replaceState({}, "", url.pathname + url.search);
    }

    // Defer setState so we don't sync-update during effect render.
    const timers: number[] = [];
    timers.push(
      window.setTimeout(() => {
        if (shouldOpenBuy) setOpen(true);
        if (creditsStatus === "success") {
          toast.success("Payment received — credits will appear in a moment.");
        }
        if (creditsStatus === "canceled") {
          toast.message("Checkout canceled — no charge was made.");
        }
      }, 0),
    );
    if (creditsStatus === "success") {
      // Webhook usually lands shortly after the redirect.
      timers.push(
        window.setTimeout(() => {
          void (async () => {
            const response = await authedFetch("/api/credits/balance");
            if (!response.ok) return;
            setData((await response.json()) as BalancePayload);
          })();
        }, 1200),
      );
    }

    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [authedFetch]);

  useEffect(() => {
    function onBuyRequest() {
      setOpen(true);
    }
    window.addEventListener(BUY_EVENT, onBuyRequest);
    return () => window.removeEventListener(BUY_EVENT, onBuyRequest);
  }, []);

  function selectQuantity(next: number) {
    const clamped = Math.min(MAX_QUANTITY, Math.max(1, next));
    setQuantity(clamped);
    setCustomValue(String(clamped));
  }

  async function checkout() {
    setBuying(true);
    try {
      const response = await authedFetch("/api/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? "Could not start checkout");
      }
      window.location.assign(body.url);
    } catch (error) {
      setBuying(false);
      toast.error(
        error instanceof Error ? error.message : "Could not start checkout",
      );
    }
  }

  const unit = data?.creditPriceCents ?? 190;

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-text-secondary">
        {data === null ? "Credits: …" : `Credits: ${data.balance}`}
      </span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button size="sm" />}>
          Buy
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Buy credits</DialogTitle>
            <DialogDescription>
              1 credit = 1 similarity search.{" "}
              {data
                ? `You have ${data.balance} left.`
                : "Loading balance…"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {PACKS.map((pack) => (
                <button
                  key={pack}
                  type="button"
                  onClick={() => selectQuantity(pack)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    quantity === pack
                      ? "border-text-primary bg-surface-1 text-text-primary"
                      : "border-border text-text-secondary hover:border-text-muted"
                  }`}
                >
                  {pack}
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-text-muted">Custom amount</span>
              <input
                type="number"
                min={1}
                max={MAX_QUANTITY}
                inputMode="numeric"
                value={customValue}
                onChange={(event) => {
                  setCustomValue(event.target.value);
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isInteger(parsed) && parsed >= 1) {
                    setQuantity(Math.min(MAX_QUANTITY, parsed));
                  }
                }}
                onBlur={() => selectQuantity(quantity)}
                className="h-9 rounded-lg border border-border bg-surface-0 px-3 text-sm text-text-primary outline-none focus-visible:border-ring"
              />
            </label>

            <p className="text-sm text-text-secondary">
              {quantity} {quantity === 1 ? "credit" : "credits"} ·{" "}
              {formatGbp(unit * quantity)}
              <span className="text-text-muted">
                {" "}
                ({formatGbp(unit)} each)
              </span>
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              disabled={buying || quantity < 1}
              onClick={() => void checkout()}
            >
              {buying ? "Redirecting…" : "Continue to Stripe"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Open the header buy dialog from anywhere (e.g. out-of-credits toast). */
export function openBuyCreditsDialog() {
  window.dispatchEvent(new Event(BUY_EVENT));
}
