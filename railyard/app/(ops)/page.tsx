import { count, dateTime } from "@mintrail/web";
import { Badge, Card, Kpi, PageHeader } from "@mintrail/web/ui";

import { load, me } from "@/lib/session";

export const metadata = { title: "Home" };

const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export default async function Home() {
  const user = await me();
  const has = (p: string) => user.permissions.includes(p);
  const [kyc, disputes, payouts, derailments, recon] = await load((a) =>
    Promise.all([
      has("kyc:review") ? safe(a.get("/internal/v1/stations", { kyc_status: "pending", limit: "100" })) : null,
      has("payments:read") ? safe(a.get("/internal/v1/disputes", { status: "needs_response", limit: "100" })) : null,
      has("payments:read") ? safe(a.get("/internal/v1/payouts", { status: "pending_approval", limit: "100" })) : null,
      safe(a.get("/internal/v1/derailments", { limit: "20" })),
      has("settlements:read") ? safe(a.get("/internal/v1/reconciliation/latest")) : null,
    ]),
  );
  const open = (derailments?.data ?? []).filter((d: { status: string }) => d.status !== "resolved");
  return (
    <>
      <PageHeader title={`Hi ${user.staff.full_name.split(" ")[0]}`} subtitle="What needs attention across MintRail right now." />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {kyc && <Kpi testId="kyc-pending" label="KYC to review" value={count(kyc.data.length)} hint={<a href="/kyc">Open queue →</a>} />}
        {disputes && (
          <Kpi
            label="Disputes needing response"
            value={count(disputes.data.length)}
            hint={<a href="/disputes?status=needs_response">View →</a>}
          />
        )}
        {payouts && <Kpi label="Payouts awaiting approval" value={count(payouts.data.length)} hint={<a href="/payouts">Review →</a>} />}
        <Kpi label="Open Derailments" value={count(open.length)} hint={<a href="/derailments">Incidents →</a>} />
      </div>
      {recon && (
        <Card title="Latest reconciliation" actions={<a href="/settlements">Settlements →</a>}>
          {recon.status === "never_run" ? (
            <p className="muted">Reconciliation has not run yet.</p>
          ) : (
            <p data-testid="recon-status">
              <Badge status={recon.status} /> {count(recon.mismatch_count)} mismatches across {count(recon.stations_checked)} merchants and{" "}
              {count(recon.settlements_checked)} settlements · {dateTime(recon.run_at)}
            </p>
          )}
        </Card>
      )}
      {open.length > 0 && (
        <Card title="Open Derailments">
          <ul>
            {open.map((d: { id: string; title: string; severity: string; status: string }) => (
              <li key={d.id}>
                <Badge status={d.severity} /> <a href={`/derailments/${d.id}`}>{d.title}</a> <Badge status={d.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
