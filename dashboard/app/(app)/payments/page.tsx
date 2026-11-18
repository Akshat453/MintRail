import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Empty, Field, PageHeader, PageNumbers, Tabs } from "@mintrail/web/ui";

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
  };
  const pageNo = Math.max(1, Math.min(10_000, Number.parseInt(one(sp.page) ?? "1", 10) || 1));
  const page = await load((a) =>
    a.get<{ data: Payment[]; has_more: boolean }>("/dashboard/v1/payments", { ...params, page: String(pageNo), limit: "25" }),
  );
  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Every payment attempt, newest first."
        actions={
          <a className="btn btn-secondary btn-sm" href="/reports">
            Export
          </a>
        }
      />
      <Tabs
        basePath="/payments"
        param="status"
        value={params.status}
        keep={{ ...params, status: undefined }}
        options={[
          ["", "All"],
          ["captured", "Succeeded"],
          ["authorized", "Uncaptured"],
          ["pending", "Pending"],
          ["failed", "Failed"],
        ]}
      />
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
          <button type="submit" className="btn-sm">
            Apply filters
          </button>
          <a className="btn btn-secondary btn-sm" href="/payments">
            Reset
          </a>
        </form>
        {page.data.length === 0 ? (
          <Empty>No payments match these filters.</Empty>
        ) : (
          <table data-testid="payments-table">
            <thead>
              <tr>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Payment method</th>
                <th>Customer</th>
                <th>Date (IST)</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map((p) => (
                <tr key={p.id}>
                  <td className="num">
                    {money(p.amount, p.currency)} <span className="muted">{p.currency}</span>
                  </td>
                  <td>
                    <Badge status={p.status} />
                    {p.error_code && <div className="muted">{label(p.error_code)}</div>}
                  </td>
                  <td>
                    <a href={`/payments/${p.id}`} className="mono">
                      {p.id}
                    </a>
                  </td>
                  <td>
                    {p.method === "card" && p.card ? (
                      <span>
                        <span className="pill">{p.card.network.toUpperCase()}</span> •••• {p.card.last4}
                      </span>
                    ) : p.method === "upi" ? (
                      <span>
                        <span className="pill">UPI</span> {p.vpa}
                      </span>
                    ) : (
                      <span>
                        <span className="pill">{label(p.method).toUpperCase()}</span> {p.bank_code ?? ""}
                      </span>
                    )}
                  </td>
                  <td>{p.email ?? <span className="muted">—</span>}</td>
                  <td className="muted">{dateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PageNumbers basePath="/payments" params={params} page={pageNo} hasMore={page.has_more} shown={page.data.length} />
      </Card>
    </>
  );
}
