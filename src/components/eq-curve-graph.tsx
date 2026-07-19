"use client";

import { useId, useMemo } from "react";
import { motion } from "motion/react";

import { transitionSlow } from "@/lib/motion";
import { FREQUENCY_BANDS, type FeatureVector } from "@/lib/types";

interface EqCurveGraphProps {
  client: FeatureVector;
  reference?: FeatureVector | null;
}

const WIDTH = 560;
const HEIGHT = 160;
const PAD = { top: 12, right: 12, bottom: 28, left: 12 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
/** Display window below the loudest band (dB). */
const DB_WINDOW = 24;
const FLOOR_ENERGY = 1e-6;

const GRID_HZ = [60, 250, 1000, 4000, 8000] as const;

function bandCenterHz(band: (typeof FREQUENCY_BANDS)[number]): number {
  return Math.sqrt(band.low * band.high);
}

function energyToDb(energy: number): number {
  return 10 * Math.log10(Math.max(energy, FLOOR_ENERGY));
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${hz / 1000}k`;
  return String(hz);
}

/** Monotone cubic Hermite (Fritsch–Carlson) — smooth without inventing peaks. */
function monotoneCubicPath(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (n < 2) return "";

  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1]! - xs[i]!;
    dx.push(h);
    dy.push((ys[i + 1]! - ys[i]!) / h);
  }

  m.push(dy[0]!);
  for (let i = 1; i < n - 1; i++) {
    if (dy[i - 1]! * dy[i]! <= 0) {
      m.push(0);
    } else {
      m.push((dy[i - 1]! + dy[i]!) / 2);
    }
  }
  m.push(dy[n - 2]!);

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(dy[i]!) < 1e-12) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i]! / dy[i]!;
      const b = m[i + 1]! / dy[i]!;
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * dy[i]!;
        m[i + 1] = t * b * dy[i]!;
      }
    }
  }

  let d = `M ${xs[0]!.toFixed(2)} ${ys[0]!.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]!;
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;
    const c1x = x0 + h / 3;
    const c1y = y0 + (m[i]! * h) / 3;
    const c2x = x1 - h / 3;
    const c2y = y1 - (m[i + 1]! * h) / 3;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d;
}

function closeBetweenCurves(
  xs: number[],
  topYs: number[],
  bottomYs: number[],
): string {
  const top = monotoneCubicPath(xs, topYs);
  if (!top) return "";
  const revXs = [...xs].reverse();
  const revYs = [...bottomYs].reverse();
  // Continue from the right end of the top curve down the bottom curve leftward
  let d = top;
  const n = revXs.length;
  if (n < 2) return d + " Z";

  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = revXs[i + 1]! - revXs[i]!;
    dx.push(h);
    dy.push((revYs[i + 1]! - revYs[i]!) / h);
  }
  m.push(dy[0]!);
  for (let i = 1; i < n - 1; i++) {
    if (dy[i - 1]! * dy[i]! <= 0) m.push(0);
    else m.push((dy[i - 1]! + dy[i]!) / 2);
  }
  m.push(dy[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(dy[i]!) < 1e-12) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i]! / dy[i]!;
      const b = m[i + 1]! / dy[i]!;
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * dy[i]!;
        m[i + 1] = t * b * dy[i]!;
      }
    }
  }

  d += ` L ${revXs[0]!.toFixed(2)} ${revYs[0]!.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]!;
    const x0 = revXs[i]!;
    const x1 = revXs[i + 1]!;
    const y0 = revYs[i]!;
    const y1 = revYs[i + 1]!;
    const c1x = x0 + h / 3;
    const c1y = y0 + (m[i]! * h) / 3;
    const c2x = x1 - h / 3;
    const c2y = y1 - (m[i + 1]! * h) / 3;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d + " Z";
}

export function EqCurveGraph({ client, reference }: EqCurveGraphProps) {
  const reactId = useId();
  const clipClientId = `${reactId}-clip-client`;
  const clipRefId = `${reactId}-clip-ref`;

  const geometry = useMemo(() => {
    const centers = FREQUENCY_BANDS.map(bandCenterHz);
    const minLog = Math.log(centers[0]!);
    const maxLog = Math.log(centers[centers.length - 1]!);

    const xAt = (hz: number) =>
      PAD.left + ((Math.log(hz) - minLog) / (maxLog - minLog)) * PLOT_W;

    const clientDb = FREQUENCY_BANDS.map((_, i) =>
      energyToDb(client.frequencyBandEnergies[i] ?? 0),
    );
    const refDb = reference
      ? FREQUENCY_BANDS.map((_, i) =>
          energyToDb(reference.frequencyBandEnergies[i] ?? 0),
        )
      : null;

    const peak = Math.max(...clientDb, ...(refDb ?? []));
    const yTop = peak;

    const yAt = (db: number) =>
      PAD.top + ((yTop - db) / DB_WINDOW) * PLOT_H;

    const xs = centers.map(xAt);
    const clientYs = clientDb.map(yAt);
    const refYs = refDb?.map(yAt) ?? null;

    const clientPath = monotoneCubicPath(xs, clientYs);
    const refPath = refYs ? monotoneCubicPath(xs, refYs) : null;

    // Clip region = area under each curve (down to plot bottom) so the
    // shared between-curves fill only shows on the hotter side per x.
    const plotBottom = PAD.top + PLOT_H;
    const underClient = `${clientPath} L ${xs[xs.length - 1]!.toFixed(2)} ${plotBottom} L ${xs[0]!.toFixed(2)} ${plotBottom} Z`;
    const underRef =
      refPath && refYs
        ? `${refPath} L ${xs[xs.length - 1]!.toFixed(2)} ${plotBottom} L ${xs[0]!.toFixed(2)} ${plotBottom} Z`
        : null;

    const between =
      refYs && refPath
        ? closeBetweenCurves(xs, clientYs, refYs)
        : null;

    const gridLines = GRID_HZ.map((hz) => ({
      hz,
      x: xAt(hz),
      label: formatHz(hz),
    }));

    return {
      xs,
      clientYs,
      refYs,
      clientPath,
      refPath,
      underClient,
      underRef,
      between,
      gridLines,
    };
  }, [client, reference]);

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label="Frequency balance comparison"
      >
        <defs>
          <clipPath id={clipClientId}>
            <path d={geometry.underClient} />
          </clipPath>
          {geometry.underRef && (
            <clipPath id={clipRefId}>
              <path d={geometry.underRef} />
            </clipPath>
          )}
        </defs>

        {/* Plot frame */}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          className="fill-surface-0/60"
          rx={4}
        />

        {/* Vertical frequency grid */}
        {geometry.gridLines.map(({ hz, x, label }) => (
          <g key={hz}>
            <line
              x1={x}
              y1={PAD.top}
              x2={x}
              y2={PAD.top + PLOT_H}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <text
              x={x}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-text-muted font-mono"
              fontSize={10}
            >
              {label}
            </text>
          </g>
        ))}

        {/* Divergence: amber where reference is hotter (under client clip = client below ref) */}
        {geometry.between && geometry.underRef && (
          <>
            <motion.path
              d={geometry.between}
              className="fill-reference-muted"
              clipPath={`url(#${clipClientId})`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...transitionSlow, delay: 0.2 }}
            />
            <motion.path
              d={geometry.between}
              className="fill-client-muted"
              clipPath={`url(#${clipRefId})`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...transitionSlow, delay: 0.2 }}
            />
          </>
        )}

        {/* Curves */}
        {geometry.refPath && (
          <motion.path
            d={geometry.refPath}
            fill="none"
            className="stroke-reference"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={transitionSlow}
          />
        )}
        <motion.path
          d={geometry.clientPath}
          fill="none"
          className="stroke-client"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={transitionSlow}
        />

        {/* Sample points */}
        {geometry.xs.map((x, i) => (
          <g key={FREQUENCY_BANDS[i]!.name}>
            {geometry.refYs && (
              <circle
                cx={x}
                cy={geometry.refYs[i]}
                r={2.5}
                className="fill-reference"
              />
            )}
            <circle
              cx={x}
              cy={geometry.clientYs[i]}
              r={2.5}
              className="fill-client"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
