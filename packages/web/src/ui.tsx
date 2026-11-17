/** Presentational building blocks (server components; no client JS). */
import type { ReactNode } from "react";

import { label as humanize } from "./index";

const TONE: Record<string, string> = {
  captured: "ok",
  processed: "ok",
  succeeded: "ok",
  won: "ok",
  verified: "ok",
  active: "ok",
  enabled: "ok",
  resolved: "ok",
  paid: "ok",
  ok: "ok",
  authorized: "info",
  pending: "warn",
  processing: "info",
  queued: "info",
  sending: "info",
  under_review: "info",
  investigating: "bad",
  mitigated: "warn",
  needs_response: "warn",
  pending_approval: "warn",
  created: "muted",
  attempted: "muted",
  failed: "bad",
  lost: "bad",
  rejected: "bad",
  revoked: "muted",
  disabled: "muted",
  cancelled: "muted",
  suspended: "bad",
  mismatch: "bad",
  sev1: "bad",
  sev2: "bad",
  sev3: "warn",
  sev4: "muted",
};

export function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${TONE[status] ?? "muted"}`}>{humanize(status)}</span>;
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <div className="kpi" data-testid={testId}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Flash({ msg, err }: { msg?: string | null; err?: string | null }) {
  if (err)
    return (
      <div className="flash flash-err" role="alert">
        {err}
      </div>
    );
  if (msg)
    return (
      <div className="flash flash-ok" role="status">
        {msg}
      </div>
    );
  return null;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Dl({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="dl">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Cursor pagination links: keeps current filters, adds ``starting_after``. */
export function Pager({
  basePath,
  params,
  lastId,
  hasMore,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  lastId?: string;
  hasMore: boolean;
}) {
  const q = (extra: Record<string, string | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...extra })) if (v) s.set(k, v);
    const t = s.toString();
    return `${basePath}${t ? `?${t}` : ""}`;
  };
  return (
    <nav className="pager">
      {params.starting_after ? <a href={q({ starting_after: undefined })}>← First page</a> : <span />}
      {hasMore && lastId ? <a href={q({ starting_after: lastId })}>Next page →</a> : <span className="muted">End of list</span>}
    </nav>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono">{children}</code>;
}
