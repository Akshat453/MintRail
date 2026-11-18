/** Presentational building blocks (server components; no client JS). */
import type { ReactNode } from "react";

import { Icon } from "./icons";
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

const TONE_ICON: Record<string, string | undefined> = { ok: "ok", bad: "alert", warn: "clock", info: "clock" };
const TERMINAL = new Set(["failed", "rejected", "lost"]);

const sentence = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function Badge({ status }: { status: string }) {
  const tone = TONE[status] ?? "muted";
  const icon = TERMINAL.has(status) ? "x" : TONE_ICON[tone];
  return (
    <span className={`badge badge-${tone}`}>
      {icon && <Icon name={icon} size={12} />}
      {sentence(humanize(status))}
    </span>
  );
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

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
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
        <Icon name="alert" />
        <span>{err}</span>
      </div>
    );
  if (msg)
    return (
      <div className="flash flash-ok" role="status">
        <Icon name="ok" />
        <span>{msg}</span>
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
      <span>{hasMore ? "Showing a page of results" : "End of list"}</span>
      <span className="row">
        {params.starting_after && (
          <a className="btn btn-secondary btn-sm" href={q({ starting_after: undefined })}>
            First page
          </a>
        )}
        {hasMore && lastId && (
          <a className="btn btn-secondary btn-sm" href={q({ starting_after: lastId })}>
            Next <Icon name="arrow" size={14} />
          </a>
        )}
      </span>
    </nav>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono">{children}</code>;
}

const href = (basePath: string, params: Record<string, string | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const t = s.toString();
  return `${basePath}${t ? `?${t}` : ""}`;
};

/** Numbered pagination links (``page=N``), keeping the current filters. */
export function PageNumbers({
  basePath,
  params,
  page,
  hasMore,
  shown,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  hasMore: boolean;
  shown: number;
}) {
  const at = (n: number) => href(basePath, { ...params, page: n > 1 ? String(n) : undefined });
  return (
    <nav className="pager" aria-label="Pagination">
      <span>
        Page {page}
        {shown > 0 && ` · ${shown} result${shown === 1 ? "" : "s"}`}
      </span>
      <span className="row">
        {page > 1 && (
          <a className="btn btn-secondary btn-sm" href={at(page - 1)}>
            Previous
          </a>
        )}
        {hasMore && (
          <a className="btn btn-secondary btn-sm" href={at(page + 1)}>
            Next <Icon name="arrow" size={14} />
          </a>
        )}
      </span>
    </nav>
  );
}

/** Underlined filter tabs that set one query parameter (e.g. status). */
export function Tabs({
  basePath,
  param,
  value,
  options,
  keep = {},
}: {
  basePath: string;
  param: string;
  value: string | undefined;
  options: [string, string][];
  keep?: Record<string, string | undefined>;
}) {
  return (
    <nav className="tabs">
      {options.map(([v, text]) => (
        <a key={v || "all"} href={href(basePath, { ...keep, [param]: v || undefined })} className={(value ?? "") === v ? "on" : undefined}>
          {text}
        </a>
      ))}
    </nav>
  );
}

export { Icon } from "./icons";
