import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Empty, Flash, PageHeader } from "@mintrail/web/ui";

import { payoutDecision } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Payout approvals" };

export default async function PayoutsPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, user, csrf] = await Promise.all([searchParams, me(), csrfToken()]);
  const status = one(sp.status) ?? "pending_approval";
  const page = await load((a) => a.get("/internal/v1/payouts", { status, limit: "50" }));
  const approver = user.permissions.includes("payouts:approve");
  return (
    <>
      <PageHeader title="Payout approvals" subtitle="Payouts above a merchant's approval threshold wait for one finance approver." />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card>
        <form className="filters" method="get">
          <select name="status" defaultValue={status}>
            {["pending_approval", "queued", "processing", "processed", "failed", "rejected", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <button type="submit">Show</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <table data-testid="payout-approvals">
            <thead>
              <tr>
                <th>Payout</th>
                <th>Merchant</th>
                <th>Beneficiary</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Created</th>
                {approver && status === "pending_approval" && <th>Decision</th>}
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (p: {
                  id: string;
                  station_id: string;
                  amount: bigint;
                  mode: string;
                  purpose: string;
                  status: string;
                  created_at: string;
                  beneficiary: { name: string; account_number: string | null; ifsc: string | null; vpa: string | null };
                }) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>
                      <a className="mono" href={`/merchants/${p.station_id}`}>
                        {p.station_id}
                      </a>
                    </td>
                    <td>
                      {p.beneficiary.name}
                      <div className="muted">
                        {p.mode} · {p.beneficiary.vpa ?? `${p.beneficiary.ifsc} ${p.beneficiary.account_number}`} · {label(p.purpose)}
                      </div>
                    </td>
                    <td className="num">{money(p.amount)}</td>
                    <td>
                      <Badge status={p.status} />
                    </td>
                    <td>{dateTime(p.created_at)}</td>
                    {approver && status === "pending_approval" && (
                      <td>
                        <div className="row">
                          <form action={payoutDecision}>
                            <Hidden csrf={csrf} values={{ payout_id: p.id, decision: "approve" }} />
                            <Submit confirm={`Approve ${money(p.amount)} to ${p.beneficiary.name}?`}>Approve</Submit>
                          </form>
                          <form action={payoutDecision} className="row">
                            <Hidden csrf={csrf} values={{ payout_id: p.id, decision: "reject" }} />
                            <input name="reason" placeholder="Reason" minLength={3} required />
                            <Submit variant="danger">Reject</Submit>
                          </form>
                        </div>
                      </td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
