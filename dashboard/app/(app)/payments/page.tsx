import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Empty, Field, PageHeader, Pager } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Payments" };

interface Payment {
  id: string;
  amount: bigint;
  currency: string;
  method: string;
  status: string;
  email: string | null;
  vpa: string | null;
  card: { network: string; last4: string } | null;
  bank_code: string | null;
  error_code: string | null;
  created_at: string;
}

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = {
    status: one(sp.status),
    method: one(sp.method),
    q: one(sp.q),
    from: one(sp.from),
    to: one(sp.to),
    starting_after: one(sp.starting_after),
  };
  const page = await load((a) => a.get<{ data: Payment[]; has_more: boolean }>("/dashboard/v1/payments", { ...params, limit: "25" }));
  return (
    <>
      <PageHeader title="Payments" subtitle="Every payment attempt, newest first." />
      <Card>
        <form className="filters" method="get">
          <Field label="Search">
            <input name="q" defaultValue={params.q} placeholder="pay_… / ord_… / customer email" size={30} />
          </Field>
          <Field label="Status">
            <select name="status" defaultValue={params.status ?? ""}>
              <option value="">Any</option>
              {["captured", "authorized", "pending", "failed", "created"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Method">
            <select name="method" defaultValue={params.method ?? ""}>
              <option value="">Any</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="netbanking">Netbanking</option>
            </select>
          </Field>
          <Field label="From">
            <input type="date" name="from" defaultValue={params.from} />
          </Field>
          <Field label="To">
            <input type="date" name="to" defaultValue={params.to} />
          </Field>
          <button type="submit">Filter</button>
          <a className="btn btn-secondary" href="/payments">
            Reset
          </a>
        </form>
        {page.data.length === 0 ? (
          <Empty>No payments match these filters.</Empty>
        ) : (
          <table data-testid="payments-table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Customer</th>
                <th>Method</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Created (IST)</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`/payments/${p.id}`} className="mono">
                      {p.id}
                    </a>
                  </td>
                  <td>{p.email ?? "—"}</td>
                  <td>
                    {p.method === "card" && p.card
                      ? `${p.card.network} •${p.card.last4}`
                      : p.method === "upi"
                        ? p.vpa
                        : `${label(p.method)} ${p.bank_code ?? ""}`}
                  </td>
                  <td>
                    <Badge status={p.status} /> {p.error_code && <span className="muted">{label(p.error_code)}</span>}
                  </td>
                  <td className="num">{money(p.amount, p.currency)}</td>
                  <td>{dateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager basePath="/payments" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
