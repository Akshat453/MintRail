import { count, label, money, moneyCompact, percentBps, shortDate } from "@mintrail/web";
import { BarChart, RateLine, Split } from "@mintrail/web/charts";
import { Card, Kpi, PageHeader } from "@mintrail/web/ui";

import { load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Overview" };

interface Overview {
  totals: {
    volume: bigint;
    payments: bigint;
    failed: bigint;
    success_rate_bps: bigint | null;
    average_ticket: bigint | null;
    refunds: bigint;
    refunded_amount: bigint;
    open_disputes: bigint;
    disputes: bigint;
  };
  method_mix: { method: string; payments: bigint; volume: bigint }[];
  balances: Record<string, Record<string, bigint>>;
  series: { date: string; attempts: bigint; succeeded: bigint; failed: bigint; volume: bigint }[];
}

export default async function OverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const days = ["7", "30", "90"].includes(one(sp.days) ?? "") ? one(sp.days)! : "30";
  const [user, ov] = await Promise.all([me(), load((a) => a.get<Overview>("/dashboard/v1/overview", { days }))]);
  const t = ov.totals;
  const inr = ov.balances.INR ?? {};
  return (
    <>
      <PageHeader
        title={`Good to see you, ${user.user.full_name.split(" ")[0]}`}
        subtitle={`${user.station.display_name} · last ${days} days · ${user.livemode ? "live" : "test"} data`}
        actions={["7", "30", "90"].map((d) => (
          <a key={d} href={`/?days=${d}`} className={`btn btn-sm ${d === days ? "" : "btn-secondary"}`}>
            {d}d
          </a>
        ))}
      />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Kpi testId="kpi-volume" label="Captured volume" value={moneyCompact(t.volume)} hint={money(t.volume)} />
        <Kpi
          testId="kpi-success"
          label="Success rate"
          value={percentBps(t.success_rate_bps)}
          hint={`${count(t.payments)} succeeded · ${count(t.failed)} failed`}
        />
        <Kpi label="Average ticket" value={money(t.average_ticket)} hint={`${count(t.payments)} payments`} />
        <Kpi
          label="Available balance"
          value={money(inr.merchant_balance ?? 0n)}
          hint={inr.reserve ? `${money(inr.reserve)} in rolling reserve` : "Settles on your schedule"}
        />
      </div>
      <div className="grid grid-2">
        <Card title="Daily captured volume">
          <BarChart
            points={ov.series.map((s) => ({ label: shortDate(s.date), title: s.date, value: s.volume }))}
            format={(v) => moneyCompact(v)}
          />
        </Card>
        <Card title="Payment success rate">
          <RateLine
            points={ov.series.map((s) => ({
              label: s.date,
              value: s.succeeded + s.failed === 0n ? -1n : (s.succeeded * 10_000n) / (s.succeeded + s.failed),
            }))}
          />
          <p className="muted">Successful ÷ (successful + failed) payments, per IST day. Dashed line: 90%.</p>
        </Card>
      </div>
      <div className="grid grid-3">
        <Card title="Payment methods">
          {ov.method_mix.length ? (
            <Split
              parts={ov.method_mix.map((m) => ({ label: label(m.method).toUpperCase(), value: m.volume }))}
              format={(v) => moneyCompact(v)}
            />
          ) : (
            <p className="muted">No payments yet.</p>
          )}
        </Card>
        <Card title="Refunds">
          <div className="kpi-value">{count(t.refunds)}</div>
          <p className="muted">{money(t.refunded_amount)} refunded in this period</p>
          <a href="/refunds">View refunds →</a>
        </Card>
        <Card title="Disputes">
          <div className="kpi-value">{count(t.open_disputes)} open</div>
          <p className="muted">{count(t.disputes)} disputes all time</p>
          <a href="/disputes?status=needs_response">Respond to disputes →</a>
        </Card>
      </div>
    </>
  );
}
