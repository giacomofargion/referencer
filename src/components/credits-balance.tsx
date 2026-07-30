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

const BUY_EVENT = "tonemap:buy-credits";

interface CreditPack {
  quantity: number;
  unitCents: number;
}

interface BalancePayload {
  balance: number;
  creditPriceCents: number;
  freeStarterCredits: number;
  packs: CreditPack[];
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
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await authedFetch("/api/credits/balance");
      if (!response.ok) return;
      const payload = (await response.json()) as BalancePayload;
      if (!cancelled) {
        setData(payload);
        const firstPack = payload.packs?.[0]?.quantity ?? 5;
        setQuantity(firstPack);
      }
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

  const packs = data?.packs ?? [
    { quantity: 5, unitCents: 49 },
    { quantity: 20, unitCents: 39 },
    { quantity: 50, unitCents: 35 },
    { quantity: 100, unitCents: 29 },
  ];
  const baseUnit = data?.creditPriceCents ?? 49;
  const selected = packs.find((pack) => pack.quantity === quantity) ?? packs[0];
  const unit = selected?.unitCents ?? baseUnit;
  const total = unit * (selected?.quantity ?? quantity);
  const savePct =
    baseUnit > unit ? Math.round((1 - unit / baseUnit) * 100) : 0;

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
              1 credit = 1 similarity search · from {formatGbp(baseUnit)} each.
              {data ? ` You have ${data.balance} left.` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {packs.map((pack) => {
              const packTotal = pack.unitCents * pack.quantity;
              const packSave =
                baseUnit > pack.unitCents
                  ? Math.round((1 - pack.unitCents / baseUnit) * 100)
                  : 0;
              const selectedPack = quantity === pack.quantity;
              return (
                <button
                  key={pack.quantity}
                  type="button"
                  onClick={() => setQuantity(pack.quantity)}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selectedPack
                      ? "border-text-primary bg-surface-1 text-text-primary"
                      : "border-border text-text-secondary hover:border-text-muted"
                  }`}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-text-primary">
                      {pack.quantity} credits
                    </span>
                    <span className="text-xs text-text-muted">
                      {formatGbp(pack.unitCents)} each
                      {packSave > 0 ? ` · save ${packSave}%` : ""}
                    </span>
                  </span>
                  <span className="text-sm font-medium text-text-primary">
                    {formatGbp(packTotal)}
                  </span>
                </button>
              );
            })}

            <p className="text-sm text-text-secondary">
              {selected?.quantity ?? quantity} credits · {formatGbp(total)}
              {savePct > 0 ? (
                <span className="text-text-muted">
                  {" "}
                  ({formatGbp(unit)} each · {savePct}% off)
                </span>
              ) : (
                <span className="text-text-muted">
                  {" "}
                  ({formatGbp(unit)} each)
                </span>
              )}
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              disabled={buying || !selected}
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
