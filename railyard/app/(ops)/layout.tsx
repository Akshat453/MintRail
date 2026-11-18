import type { ReactNode } from "react";

import { Icon } from "@mintrail/web/icons";

import { logout } from "@/app/actions";
import { NavLinks } from "@/components/client";
import { csrfToken, me } from "@/lib/session";

type Item = [href: string, label: string, permission: string | null, icon: string];
const SECTIONS: [string | null, Item[]][] = [
  [null, [["/", "Home", null, "home"]]],
  [
    "Merchants",
    [
      ["/kyc", "KYC queue", "kyc:review", "check"],
      ["/merchants", "Merchants", "stations:read", "store"],
    ],
  ],
  [
    "Money",
    [
      ["/disputes", "Disputes", "payments:read", "shield"],
      ["/payouts", "Payout approvals", "payments:read", "send"],
      ["/settlements", "Settlements", "settlements:read", "bank"],
    ],
  ],
  [
    "Platform",
    [
      ["/webhooks", "Webhook replay", "webhooks:replay", "webhook"],
      ["/derailments", "Derailments", null, "alert"],
      ["/audit", "Audit log", "audit:read", "list"],
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

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const [user, csrf] = await Promise.all([me(), csrfToken()]);
  const nav = SECTIONS.flatMap(([title, items]) => {
    const allowed = items
      .filter(([, , p]) => p === null || user.permissions.includes(p))
      .map(([h, l, , i]) => [h, l, i] as [string, string, string]);
    return allowed.length ? [...(title ? [title] : []), ...allowed] : [];
  });
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark alt">R</span>
          <span>
            Railyard
            <small>MintRail operations</small>
          </span>
        </div>
        <NavLinks items={nav} />
        <div className="side-foot">
          <strong>Internal tool</strong>
          Every action is recorded in the staff audit log.
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          {user.permissions.includes("stations:read") ? (
            <form className="search" action="/merchants" method="get" role="search">
              <Icon name="search" />
              <input name="q" type="search" placeholder="Find a merchant by name or ID" aria-label="Search merchants" />
            </form>
          ) : (
            <span />
          )}
          <div className="account">
            <span className="pill pill-staff" data-testid="role">
              {user.staff.role.toUpperCase()}
            </span>
            <span className="who">
              <span className="avatar" aria-hidden="true">
                {initials(user.staff.full_name)}
              </span>
              <span>{user.staff.full_name}</span>
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
