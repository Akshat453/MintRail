import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Empty, PageHeader, Pager } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Refunds" };

export default async function RefundsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = { status: one(sp.status), starting_after: one(sp.starting_after) };
  // Large merchants have tens of thousands of refunds; the list is cached briefly.
  const page = await load((a) => a.get("/dashboard/v1/refunds", { ...params, limit: "25" }, { revalidate: 300 }));
  return (
    <>
      <PageHeader title="Refunds" subtitle="Issue refunds from a payment's page. Instant refunds cost 0.5% + GST." />
      <Card>
        <form className="filters" method="get">
          <select name="status" defaultValue={params.status ?? ""}>
            <option value="">Any status</option>
            <option>pending</option>
            <option>processed</option>
            <option>failed</option>
          </select>
          <button type="submit">Filter</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No refunds yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Refund</th>
                <th>Payment</th>
                <th>Reason</th>
                <th>Speed</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="num">Fee + GST</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (r: {
                  id: string;
                  payment_id: string;
                  reason: string;
                  speed: string;
                  status: string;
                  amount: bigint;
                  fee: bigint;
                  tax: bigint;
                  currency: string;
                  created_at: string;
                }) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <a className="mono" href={`/payments/${r.payment_id}`}>
                        {r.payment_id}
                      </a>
                    </td>
                    <td>{label(r.reason)}</td>
                    <td>{r.speed}</td>
                    <td>
                      <Badge status={r.status} />
                    </td>
                    <td className="num">{money(r.amount, r.currency)}</td>
                    <td className="num">{money(r.fee + r.tax, r.currency)}</td>
                    <td>{dateTime(r.created_at)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <Pager basePath="/refunds" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
