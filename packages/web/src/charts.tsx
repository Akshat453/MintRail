/** Server-rendered SVG charts. Values are bigint; scaling uses Number only for pixel geometry. */

export interface Point {
  label: string;
  value: bigint;
  title?: string;
}

const W = 720;

export function BarChart({ points, height = 180, format }: { points: Point[]; height?: number; format: (v: bigint) => string }) {
  const max = points.reduce((m, p) => (p.value > m ? p.value : m), 0n) || 1n;
  const gap = 4;
  const bw = Math.max(2, (W - gap * points.length) / Math.max(points.length, 1));
  const tick = (i: number) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height + 24}`} role="img" aria-label="Daily volume">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={Math.round(8 + (height - 8) * f)} y2={Math.round(8 + (height - 8) * f)} className="chart-grid" />
      ))}
      <line x1="0" x2={W} y1={height} y2={height} className="chart-axis" />
      {points.map((p, i) => {
        const h = Math.round((Number((p.value * 1000n) / max) / 1000) * (height - 8));
        const x = i * (bw + gap);
        return (
          <g key={p.label}>
            <rect x={x} y={height - h} width={bw} height={h} rx="3" className="chart-bar">
              <title>{`${p.title ?? p.label}: ${format(p.value)}`}</title>
            </rect>
            {tick(i) && (
              <text x={x + bw / 2} y={height + 16} textAnchor="middle" className="chart-label">
                {p.label}
              </text>
            )}
          </g>
        );
      })}
      <text x={W} y="12" textAnchor="end" className="chart-label">
        max {format(max)}
      </text>
    </svg>
  );
}

/** A line of percentages expressed in basis points (0–10000). */
export function RateLine({ points, height = 120, floorBps = 8000n }: { points: Point[]; height?: number; floorBps?: bigint }) {
  const valid = points.filter((p) => p.value >= 0n);
  if (valid.length < 2) return null;
  const span = 10_000n - floorBps;
  const step = W / (points.length - 1);
  const y = (v: bigint) => {
    const c = v < floorBps ? floorBps : v;
    return height - (Number(((c - floorBps) * 1000n) / span) / 1000) * (height - 10) - 4;
  };
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p.value < 0n ? floorBps : p.value).toFixed(1)}`)
    .join(" ");
  const area = `${d} L${W},${height} L0,${height} Z`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Success rate">
      <defs>
        <linearGradient id="mr-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0a8f6c" stopOpacity="0.18" />
          <stop offset="1" stopColor="#0a8f6c" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} className="chart-area" />
      <line x1="0" x2={W} y1={y(9_000n)} y2={y(9_000n)} className="chart-grid" />
      <text x="4" y={y(9_000n) - 4} className="chart-label">
        90%
      </text>
      <path d={d} className="chart-line" fill="none" />
    </svg>
  );
}

export function Split({ parts, format }: { parts: { label: string; value: bigint }[]; format: (v: bigint) => string }) {
  const total = parts.reduce((a, p) => a + p.value, 0n) || 1n;
  return (
    <div className="split">
      <div className="split-bar">
        {parts.map((p, i) => (
          <span
            key={p.label}
            className={`split-seg seg-${i}`}
            style={{ width: `${Number((p.value * 1000n) / total) / 10}%` }}
            title={`${p.label}: ${format(p.value)}`}
          />
        ))}
      </div>
      <ul className="split-legend">
        {parts.map((p, i) => (
          <li key={p.label}>
            <span className={`dot seg-${i}`} /> {p.label} <strong>{format(p.value)}</strong>{" "}
            <span className="muted">({(Number((p.value * 1000n) / total) / 10).toFixed(1)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
