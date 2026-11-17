import type { ReactNode } from "react";

import { logout } from "@/app/actions";
import { NavLinks } from "@/components/client";
import { csrfToken, me } from "@/lib/session";

const NAV: [string, string, string | null][] = [
  ["/", "Home", null],
  ["/kyc", "KYC queue", "kyc:review"],
  ["/merchants", "Merchants", "stations:read"],
  ["/disputes", "Disputes", "payments:read"],
  ["/payouts", "Payout approvals", "payments:read"],
  ["/webhooks", "Webhook replay", "webhooks:replay"],
  ["/settlements", "Settlements", "settlements:read"],
  ["/audit", "Audit log", "audit:read"],
  ["/derailments", "Derailments", null],
];

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const [user, csrf] = await Promise.all([me(), csrfToken()]);
  const items = NAV.filter(([, , p]) => p === null || user.permissions.includes(p)).map(([h, l]) => [h, l] as [string, string]);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">R</span>
          <span>
            Railyard<small>MintRail ops</small>
          </span>
        </div>
        <NavLinks items={items} />
        <div className="side-foot">Internal · all actions audited</div>
      </aside>
      <div className="main">
        <div className="topbar">
          <span className="pill" data-testid="role">
            {user.staff.role.toUpperCase()}
          </span>
          <div className="row">
            <span className="muted">{user.staff.full_name}</span>
            <form action={logout}>
              <input type="hidden" name="csrf" value={csrf} />
              <button className="btn-secondary btn-sm">Sign out</button>
            </form>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
