import type { ReactNode } from "react";

import { logout, setMode } from "@/app/actions";
import { NavLinks } from "@/components/client";
import { csrfToken, me } from "@/lib/session";

const NAV: [string, string, string][] = [
  ["/", "Overview", "read"],
  ["/payments", "Payments", "read"],
  ["/refunds", "Refunds", "read"],
  ["/settlements", "Settlements", "read"],
  ["/disputes", "Disputes", "read"],
  ["/payouts", "Payouts", "read"],
  ["/webhooks", "Webhooks", "webhooks"],
  ["/api-keys", "API keys", "api_keys"],
  ["/reports", "Reports", "reports"],
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, csrf] = await Promise.all([me(), csrfToken()]);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>
            MintRail<small>Dashboard</small>
          </span>
        </div>
        <NavLinks items={NAV.filter(([, , p]) => user.permissions.includes(p)).map(([href, label]) => [href, label])} />
        <div className="side-foot">
          {user.station.display_name}
          <br />
          {user.station.id}
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="row">
            <span className={`pill ${user.livemode ? "pill-live" : "pill-test"}`} data-testid="mode">
              {user.livemode ? "LIVE" : "TEST MODE"}
            </span>
            {user.station.live_enabled ? (
              <form action={setMode}>
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="mode" value={user.livemode ? "test" : "live"} />
                <button className="btn-secondary btn-sm">Switch to {user.livemode ? "test" : "live"} data</button>
              </form>
            ) : (
              <span className="muted">Live mode unlocks after KYC verification ({user.station.kyc_status})</span>
            )}
          </div>
          <div className="row">
            <span className="muted">
              {user.user.full_name} · {user.user.role}
            </span>
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
