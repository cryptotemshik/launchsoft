import { useMemo, useRef, useState } from "react";
import { formatEthShort, formatUsdApprox } from "../lib/profit";
import { niceTicks, type SeriesPoint } from "../lib/series";

const W = 820;
const H = 220;
const PAD = { top: 14, right: 16, bottom: 26, left: 56 };

/**
 * Cumulative profit line — single series, so no legend (the panel title names
 * it); crosshair + tooltip on hover; recessive grid; the line wears the only
 * accent color while all text stays in text tokens.
 */
export default function ProfitChart({
  points,
  ethUsd,
  updatedAt,
}: {
  points: SeriesPoint[];
  ethUsd: number | null;
  updatedAt: number | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    let minC = points[0].cum;
    let maxC = points[0].cum;
    for (const p of points) {
      if (p.cum < minC) minC = p.cum;
      if (p.cum > maxC) maxC = p.cum;
    }
    if (minC > 0n) minC = 0n; // keep the zero baseline in frame
    if (maxC < 0n) maxC = 0n;
    const spanC = maxC - minC === 0n ? 1n : maxC - minC;
    const x = (t: number) =>
      PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (c: bigint) =>
      H - PAD.bottom -
      (Number(c - minC) / Number(spanC)) * (H - PAD.top - PAD.bottom);
    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.cum).toFixed(1)}`)
      .join(" ");
    // Closed area under the line, down to the zero baseline, for a soft fill.
    const baseY = y(0n);
    const area =
      `${path} L${x(points[points.length - 1].t).toFixed(1)},${baseY.toFixed(1)}` +
      ` L${x(points[0].t).toFixed(1)},${baseY.toFixed(1)} Z`;
    return { t0, t1, minC, maxC, x, y, path, area };
  }, [points]);

  if (!model) {
    return <p className="dim">No profit events yet — the chart appears with the first mint.</p>;
  }

  const { t0, t1, minC, maxC, x, y, path, area } = model;
  const ticks = niceTicks(minC, maxC);
  const last = points[points.length - 1];
  const positive = last.cum >= 0n;
  const timeTicks = [t0, t0 + (t1 - t0) / 2, t1];

  const hovered =
    hover !== null
      ? points.reduce((best, p) =>
          Math.abs(p.t - hover) < Math.abs(best.t - hover) ? p : best,
        )
      : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    setHover(t0 + Math.min(1, Math.max(0, frac)) * (t1 - t0));
  }

  const fmtTime = (t: number) =>
    new Date(t * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Cumulative profit over time"
      >
        <defs>
          <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={positive ? "#00c805" : "#ff5f56"}
              stopOpacity="0.28"
            />
            <stop
              offset="100%"
              stopColor={positive ? "#00c805" : "#ff5f56"}
              stopOpacity="0"
            />
          </linearGradient>
        </defs>
        {/* soft area fill under the line */}
        <path d={area} fill="url(#profitFill)" stroke="none" />
        {/* recessive grid + y labels (ETH) */}
        {ticks.map((v) => {
          const yy = y(BigInt(Math.round(v * 1e18)));
          return (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} stroke="#0e4a22" strokeWidth="1" />
              <text x={PAD.left - 8} y={yy + 3} textAnchor="end" fontSize="10" fill="#74b389">
                {v}
              </text>
            </g>
          );
        })}
        {/* zero baseline emphasized */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(0n)}
          y2={y(0n)}
          stroke="#74b389"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        {/* x labels */}
        {timeTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={H - 8}
            textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"}
            fontSize="10"
            fill="#74b389"
          >
            {fmtTime(t)}
          </text>
        ))}
        {/* the series */}
        <path
          d={path}
          fill="none"
          stroke={positive ? "#2bf06a" : "#ff5f56"}
          strokeWidth="2.25"
          style={{
            filter: `drop-shadow(0 0 6px ${positive ? "rgba(0,200,5,0.55)" : "rgba(255,92,87,0.5)"})`,
          }}
        />
        {/* crosshair + hovered point */}
        {hovered ? (
          <g>
            <line
              x1={x(hovered.t)}
              x2={x(hovered.t)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="#74b389"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <circle
              cx={x(hovered.t)}
              cy={y(hovered.cum)}
              r="4"
              fill={positive ? "#00c805" : "#ff5f56"}
              stroke="#04200d"
              strokeWidth="2"
            />
          </g>
        ) : null}
      </svg>
      <div className="dim" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
        <span>
          {hovered ? (
            <>
              {fmtTime(hovered.t)} · {formatEthShort(hovered.cum)} ETH
              {formatUsdApprox(hovered.cum, ethUsd) ? ` (${formatUsdApprox(hovered.cum, ethUsd)})` : ""}
            </>
          ) : (
            <>
              now: {formatEthShort(last.cum)} ETH
              {formatUsdApprox(last.cum, ethUsd) ? ` (${formatUsdApprox(last.cum, ethUsd)})` : ""}
            </>
          )}
        </span>
        {updatedAt ? (
          <span>
            <span className="ok">● live</span> · updated{" "}
            {new Date(updatedAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
