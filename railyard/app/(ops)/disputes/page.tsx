import { date, label, money } from "@mintrail/web";
import { Badge, Card, Empty, PageHeader, Pager } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Disputes" };

export default async function DisputesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = { status: one(sp.status), station_id: one(sp.station_id), starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/internal/v1/disputes", { ...params, limit: "30" }));
  return (
    <>
      <PageHeader title="Disputes" subtitle="All merchants. Ops can accept or submit on a merchant's behalf." />
      <Card>
        <form className="filters" method="get">
          <select name="status" defaultValue={params.status ?? ""}>
            <option value="">Any status</option>
            {["needs_response", "under_review", "won", "lost"].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <input name="station_id" defaultValue={params.station_id} placeholder="mer_…" />
          <button type="submit">Filter</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No disputes.</Empty>
        ) : (
          <table data-testid="disputes">
            <thead>
              <tr>
                <th>Dispute</th>
                <th>Merchant</th>
                <th>Reason</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (d: {
                  id: string;
                  station_id: string;
                  reason: string;
                  status: string;
                  amount: bigint;
                  currency: string;
                  evidence_due_by: string;
                  livemode: boolean;
                }) => (
                  <tr key={d.id}>
                    <td>
                      <a className="mono" href={`/disputes/${d.id}`}>
                        {d.id}
                      </a>
                    </td>
                    <td>
                      <a className="mono" href={`/merchants/${d.station_id}`}>
                        {d.station_id}
                      </a>
                    </td>
                    <td>{label(d.reason)}</td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                    <td className="num">{money(d.amount, d.currency)}</td>
                    <td>{date(d.evidence_due_by)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <Pager basePath="/disputes" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
