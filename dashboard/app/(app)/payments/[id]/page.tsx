import { randomUUID } from "node:crypto";

import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Dl, Field, Flash, Mono, PageHeader } from "@mintrail/web/ui";

import { createRefund } from "@/app/actions";
import { Submit } from "@/components/client";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Payment" };

export default async function PaymentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const [{ id }, sp, user, csrf] = await Promise.all([params, searchParams, me(), csrfToken()]);
  const p = await load((a) => a.get(`/dashboard/v1/payments/${id}`));
  const refunded = (p.refunds as { amount: bigint; status: string }[])
    .filter((r) => r.status !== "failed")
    .reduce((a, r) => a + r.amount, 0n);
  const disputed = (p.disputes as { amount: bigint; status: string }[])
    .filter((d) => d.status !== "won")
    .reduce((a, d) => a + d.amount, 0n);
  const refundable = p.status === "captured" ? p.amount - refunded - disputed : 0n;
  return (
    <>
      <PageHeader title={money(p.amount, p.currency)} subtitle={<Mono>{p.id}</Mono>} actions={<Badge status={p.status} />} />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card title="Details">
        <Dl
          items={[
            ["Order", <Mono key="o">{p.order_id}</Mono>],
            [
              "Method",
              p.method === "card"
                ? `${p.card.network} ••••${p.card.last4} (BIN ${p.card.bin})`
                : p.method === "upi"
                  ? `UPI ${p.vpa}`
                  : `Netbanking ${p.bank_code}`,
            ],
            ["Customer", p.email ?? "—"],
            ["Created", dateTime(p.created_at)],
            ["Captured", dateTime(p.captured_at)],
            ["MDR fee", money(p.fee, p.currency)],
            ["GST on fee", money(p.tax, p.currency)],
            ["You receive", p.fee === null ? "—" : money((p.amount as bigint) - (p.fee as bigint) - (p.tax as bigint), p.currency)],
            ["Failure", p.error_code ? `${label(p.error_code)} — ${p.error_description}` : "—"],
            ["Risk", `${p.risk.decision} (score ${p.risk.score})`],
          ]}
        />
      </Card>
      <div className="grid grid-2">
        <Card title="Refunds">
          {p.refunds.length === 0 ? (
            <p className="muted">No refunds.</p>
          ) : (
            <table>
              <tbody>
                {p.refunds.map((r: { id: string; amount: bigint; status: string; speed: string; created_at: string }) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <Badge status={r.status} />
                    </td>
                    <td>{r.speed}</td>
                    <td className="num">{money(r.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {refundable > 0n && user.permissions.includes("refunds") && (
            <form action={createRefund} style={{ marginTop: 14 }} data-testid="refund-form">
              <input type="hidden" name="csrf" value={csrf} />
              <input type="hidden" name="idem" value={randomUUID()} />
              <input type="hidden" name="payment_id" value={p.id} />
              <div className="row">
                <Field label={`Amount (max ${money(refundable, p.currency)})`}>
                  <input name="amount" placeholder="Full amount" inputMode="decimal" />
                </Field>
                <Field label="Reason">
                  <select name="reason" defaultValue="requested_by_customer">
                    {["requested_by_customer", "order_cancelled", "duplicate", "fraudulent", "other"].map((r) => (
                      <option key={r} value={r}>
                        {label(r)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Speed">
                  <select name="speed" defaultValue="normal">
                    <option value="normal">Normal (5–7 days, free)</option>
                    {p.method !== "netbanking" && <option value="instant">Instant (0.5% + GST)</option>}
                  </select>
                </Field>
              </div>
              <Submit confirm="Issue this refund? The amount is deducted from your balance now.">Issue refund</Submit>
            </form>
          )}
        </Card>
        <Card title="Timeline">
          <ul className="timeline">
            {p.events.map((e: { id: string; type: string; created_at: string }) => (
              <li key={e.id}>
                <strong>{e.type}</strong>
                <div className="muted">{dateTime(e.created_at)}</div>
              </li>
            ))}
            {p.events.length === 0 && <li className="muted">No webhook events recorded for this payment.</li>}
          </ul>
          {p.disputes.map((d: { id: string; status: string; amount: bigint }) => (
            <p key={d.id}>
              Dispute <a href={`/disputes/${d.id}`}>{d.id}</a> <Badge status={d.status} /> {money(d.amount, p.currency)}
            </p>
          ))}
        </Card>
      </div>
    </>
  );
}
