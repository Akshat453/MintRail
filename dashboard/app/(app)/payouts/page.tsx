import { randomUUID } from "node:crypto";

import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Empty, Field, Flash, PageHeader, Pager } from "@mintrail/web/ui";

import { bulkPayouts, createPayout } from "@/app/actions";
import { Submit } from "@/components/client";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Payouts" };

export default async function PayoutsPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, user, csrf] = await Promise.all([searchParams, me(), csrfToken()]);
  const params = { status: one(sp.status), starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/dashboard/v1/payouts", { ...params, limit: "25" }));
  const canPay = user.permissions.includes("payouts");
  return (
    <>
      <PageHeader title="Payouts" subtitle="Pay vendors, staff and customers straight from your MintRail balance (Freight)." />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      {canPay && (
        <div className="grid grid-2">
          <Card title="New payout">
            <form action={createPayout} data-testid="payout-form">
              <input type="hidden" name="csrf" value={csrf} />
              <input type="hidden" name="idem" value={randomUUID()} />
              <div className="row">
                <Field label="Amount (₹)">
                  <input name="amount" required inputMode="decimal" placeholder="2500" />
                </Field>
                <Field label="Mode">
                  <select name="mode" defaultValue="IMPS">
                    <option>IMPS</option>
                    <option>NEFT</option>
                    <option>RTGS</option>
                    <option>UPI</option>
                  </select>
                </Field>
                <Field label="Purpose">
                  <select name="purpose" defaultValue="vendor_bill">
                    {["vendor_bill", "salary", "refund", "cashback", "rent", "utility_bill", "other"].map((p) => (
                      <option key={p} value={p}>
                        {label(p)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Beneficiary name">
                <input name="name" required minLength={3} />
              </Field>
              <div className="row">
                <Field label="Account number">
                  <input name="account_number" inputMode="numeric" />
                </Field>
                <Field label="IFSC">
                  <input name="ifsc" placeholder="HDFC0001234" />
                </Field>
                <Field label="…or UPI ID">
                  <input name="vpa" placeholder="name@okhdfcbank" />
                </Field>
              </div>
              <Field label="Reference">
                <input name="reference" maxLength={40} />
              </Field>
              <Submit>Send payout</Submit>
            </form>
          </Card>
          <Card title="Bulk upload">
            <p className="muted">
              CSV columns: <code>beneficiary_name, account_number, ifsc, vpa, amount, mode, purpose, reference, narration</code> — amount in
              rupees. Up to 1,000 rows; bad rows are reported, good ones are paid.
            </p>
            <form action={bulkPayouts}>
              <input type="hidden" name="csrf" value={csrf} />
              <Field label="CSV file">
                <input type="file" name="file" accept=".csv,text/csv" required />
              </Field>
              <Submit variant="secondary">Upload</Submit>
            </form>
          </Card>
        </div>
      )}
      <Card title="History">
        {page.data.length === 0 ? (
          <Empty>No payouts yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Payout</th>
                <th>Beneficiary</th>
                <th>Mode</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>UTR</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (p: {
                  id: string;
                  beneficiary: { name: string; account_number: string | null; vpa: string | null };
                  mode: string;
                  status: string;
                  amount: bigint;
                  utr: string | null;
                  failure_reason: string | null;
                  created_at: string;
                }) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>
                      {p.beneficiary.name}
                      <div className="muted">{p.beneficiary.vpa ?? p.beneficiary.account_number}</div>
                    </td>
                    <td>{p.mode}</td>
                    <td>
                      <Badge status={p.status} /> {p.failure_reason && <span className="muted">{label(p.failure_reason)}</span>}
                    </td>
                    <td className="num">{money(p.amount)}</td>
                    <td className="mono">{p.utr ?? "—"}</td>
                    <td>{dateTime(p.created_at)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <Pager basePath="/payouts" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
