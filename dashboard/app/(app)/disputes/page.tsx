import { date, label, money } from "@mintrail/web";
import { Badge, Card, Empty, PageHeader, Pager } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Disputes" };

export default async function DisputesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = { status: one(sp.status), starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/dashboard/v1/disputes", { ...params, limit: "25" }));
  return (
    <>
      <PageHeader
        title="Disputes"
        subtitle="Chargebacks raised by cardholders' banks. Respond before the deadline or the dispute is lost."
      />
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
          <button type="submit">Filter</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No disputes. 🎉</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Dispute</th>
                <th>Reason</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Respond by</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (d: { id: string; reason: string; status: string; amount: bigint; currency: string; evidence_due_by: string }) => (
                  <tr key={d.id}>
                    <td>
                      <a className="mono" href={`/disputes/${d.id}`}>
                        {d.id}
                      </a>
                    </td>
                    <td>{label(d.reason)}</td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                    <td className="num">{money(d.amount, d.currency)}</td>
                    <td>{d.status === "needs_response" ? <strong>{date(d.evidence_due_by)}</strong> : "—"}</td>
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
