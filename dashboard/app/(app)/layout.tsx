import type { ReactNode } from "react";

import { Icon } from "@mintrail/web/icons";

import { logout, setMode } from "@/app/actions";
import { NavLinks } from "@/components/client";
import { csrfToken, me } from "@/lib/session";

type Item = [href: string, label: string, permission: string, icon: string];
const SECTIONS: [string | null, Item[]][] = [
  [
    null,
    [
      ["/", "Home", "read", "home"],
      ["/payments", "Payments", "read", "card"],
      ["/refunds", "Refunds", "read", "refund"],
      ["/disputes", "Disputes", "read", "shield"],
    ],
  ],
  [
    "Money out",
    [
      ["/settlements", "Settlements", "read", "bank"],
      ["/payouts", "Payouts", "read", "send"],
      ["/reports", "Reports", "reports", "report"],
    ],
  ],
  [
    "Developers",
    [
      ["/webhooks", "Webhooks", "webhooks", "webhook"],
      ["/api-keys", "API keys", "api_keys", "key"],
    ],
  ],
];

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, csrf] = await Promise.all([me(), csrfToken()]);
  const nav = SECTIONS.flatMap(([title, items]) => {
    const allowed = items.filter(([, , p]) => user.permissions.includes(p)).map(([h, l, , i]) => [h, l, i] as [string, string, string]);
    return allowed.length ? [...(title ? [title] : []), ...allowed] : [];
  });
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>
            {user.station.display_name}
            <small>MintRail</small>
          </span>
        </div>
        <NavLinks items={nav} />
        <div className="side-foot">
          <strong>{user.station.display_name}</strong>
          <span className="mono">{user.station.id}</span>
        </div>
      </aside>
      <div className="main">
        {!user.livemode && <div className="mode-band" />}
        <header className="topbar">
          <form className="search" action="/payments" method="get" role="search">
            <Icon name="search" />
            <input name="q" type="search" placeholder="Search payments by ID, order or email" aria-label="Search payments" />
          </form>
          <div className="account">
            <span className={`pill ${user.livemode ? "pill-live" : "pill-test"}`} data-testid="mode">
              {user.livemode ? "LIVE" : "TEST MODE"}
            </span>
            {user.station.live_enabled ? (
              <form action={setMode}>
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="mode" value={user.livemode ? "test" : "live"} />
                <button className="btn-secondary btn-sm">View {user.livemode ? "test" : "live"} data</button>
              </form>
            ) : (
              <span className="muted" style={{ fontSize: 12.5 }}>
                Live mode unlocks after KYC ({user.station.kyc_status})
              </span>
            )}
            <span className="who">
              <span className="avatar" aria-hidden="true">
                {initials(user.user.full_name)}
              </span>
              <span>
                {user.user.full_name}
                <small>{user.user.role}</small>
              </span>
            </span>
            <form action={logout}>
              <input type="hidden" name="csrf" value={csrf} />
              <button className="btn-ghost btn-sm icon-btn" title="Sign out">
                <Icon name="logout" />
                Sign out
              </button>
            </form>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
