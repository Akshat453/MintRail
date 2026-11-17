import { count, dateTime, money, moneyCompact, percentBps } from "@mintrail/web";
import { Badge, Card, Dl, Field, Flash, Kpi, Mono, PageHeader } from "@mintrail/web/ui";

import { stationStatus, updatePolicy } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Merchant" };

const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const rupees = (paise: bigint) => `${paise / 100n}`;

export default async function MerchantPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const [{ id }, sp, user, csrf] = await Promise.all([params, searchParams, me(), csrfToken()]);
  const has = (p: string) => user.permissions.includes(p);
  const s = await load((a) => a.get(`/internal/v1/stations/${id}`));
  const live = s.kyc_status === "verified";
  const [ov, policy, payments, users, keys] = await load((a) =>
    Promise.all([
      safe(a.get(`/internal/v1/stations/${id}/overview`, { livemode: String(live), days: "30" })),
      safe(a.get(`/internal/v1/stations/${id}/policy`)),
      has("payments:read") ? safe(a.get(`/internal/v1/stations/${id}/payments`, { limit: "10" })) : null,
      safe(a.get(`/internal/v1/stations/${id}/dashboard_users`)),
      safe(a.get(`/internal/v1/stations/${id}/api_keys`)),
    ]),
  );
  return (
    <>
      <PageHeader
        title={s.display_name}
        subtitle={<Mono>{s.id}</Mono>}
        actions={
          <>
            <Badge status={s.kyc_status} /> <Badge status={s.status} />
          </>
        }
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      {ov && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Kpi label={`Volume · 30d · ${live ? "live" : "test"}`} value={moneyCompact(ov.totals.volume)} />
          <Kpi label="Success rate" value={percentBps(ov.totals.success_rate_bps)} hint={`${count(ov.totals.payments)} captured`} />
          <Kpi
            label="Balance"
            value={money(ov.balances.INR?.merchant_balance ?? 0n)}
            hint={ov.balances.INR?.reserve ? `${money(ov.balances.INR.reserve)} reserve` : undefined}
          />
          <Kpi label="Open disputes" value={count(ov.totals.open_disputes)} hint={`${count(ov.totals.refunds)} refunds in 30d`} />
        </div>
      )}
      <div className="grid grid-2">
        <Card title="Profile">
          <Dl
            items={[
              ["Legal name", s.legal_name],
              ["Email", s.email],
              ["MCC", s.business_category],
              ["Fee plan", s.settings.fee_plan],
              ["Settlement", s.settings.settlement_schedule],
              ["KYC reviewed", dateTime(s.kyc_reviewed_at)],
              ["Suspended reason", s.suspended_reason ?? "—"],
              ["Created", dateTime(s.created_at)],
            ]}
          />
          {has("stations:suspend") && (
            <form action={stationStatus} className="row" style={{ marginTop: 12 }}>
              <Hidden csrf={csrf} values={{ station_id: s.id, op: s.status === "active" ? "suspend" : "reactivate" }} />
              {s.status === "active" && <input name="reason" placeholder="Reason" minLength={3} required />}
              <Submit
                variant={s.status === "active" ? "danger" : "secondary"}
                confirm={s.status === "active" ? "Suspend this merchant? All API calls start failing." : undefined}
              >
                {s.status === "active" ? "Suspend" : "Reactivate"}
              </Submit>
            </form>
          )}
        </Card>
        {policy && (
          <Card title="Money policy">
            <form action={updatePolicy}>
              <Hidden csrf={csrf} values={{ station_id: s.id }} />
              <div className="row">
                <Field label="Rolling reserve (bps)">
                  <input name="reserve_bps" defaultValue={String(policy.reserve_bps)} inputMode="numeric" />
                </Field>
                <Field label="Hold (days)">
                  <input name="reserve_hold_days" defaultValue={String(policy.reserve_hold_days)} inputMode="numeric" />
                </Field>
              </div>
              <div className="row">
                <Field label="Payout daily limit (₹)">
                  <input name="payout_daily_limit" defaultValue={rupees(policy.payout_daily_limit)} />
                </Field>
                <Field label="Approval above (₹)">
                  <input name="payout_approval_threshold" defaultValue={rupees(policy.payout_approval_threshold)} />
                </Field>
              </div>
              {has("stations:write") && <Submit>Save policy</Submit>}
            </form>
          </Card>
        )}
      </div>
      {payments && (
        <Card title="Recent payments">
          <table>
            <tbody>
              {payments.data.map(
                (p: {
                  id: string;
                  amount: bigint;
                  currency: string;
                  method: string;
                  status: string;
                  livemode: boolean;
                  created_at: string;
                }) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.method}</td>
                    <td>
                      <Badge status={p.status} />
                    </td>
                    <td>{p.livemode ? "live" : "test"}</td>
                    <td className="num">{money(p.amount, p.currency)}</td>
                    <td>{dateTime(p.created_at)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </Card>
      )}
      <div className="grid grid-2">
        <Card title="Dashboard users">
          <ul>
            {(users?.data ?? []).map((u: { id: string; email: string; role: string; last_login_at: string | null }) => (
              <li key={u.id}>
                {u.email} · {u.role} <span className="muted">last login {dateTime(u.last_login_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="API keys">
          <ul>
            {(keys?.data ?? []).map((k: { id: string; hint: string; mode: string; status: string }) => (
              <li key={k.id}>
                <span className="mono">{k.hint}</span> {k.mode} <Badge status={k.status} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
