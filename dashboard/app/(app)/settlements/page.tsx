import { count, date, money } from "@mintrail/web";
import { Badge, Card, Empty, PageHeader, Pager } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Settlements" };

export default async function SettlementsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = { starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/dashboard/v1/settlements", { ...params, limit: "30" }));
  return (
    <>
      <PageHeader
        title="Settlements"
        subtitle="Daily transfers to your bank account: captured payments after your T+N cutoff, net of fees, GST, refunds, payouts and reserves."
      />
      <Card>
        {page.data.length === 0 ? (
          <Empty>No settlements yet. Your first one arrives after your settlement schedule (T+1/T+2) passes.</Empty>
        ) : (
          <table data-testid="settlements-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Settlement</th>
                <th>Status</th>
                <th className="num">Entries</th>
                <th className="num">Gross</th>
                <th className="num">Fees + GST</th>
                <th className="num">Net</th>
                <th className="num">Credited</th>
                <th>UTR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (s: {
                  id: string;
                  settlement_date: string;
                  status: string;
                  entry_count: bigint;
                  gross: bigint;
                  fees: bigint;
                  tax: bigint;
                  amount: bigint;
                  currency: string;
                  payout_amount: bigint;
                  payout_currency: string;
                  fx_rate: string | null;
                  utr: string | null;
                }) => (
                  <tr key={s.id}>
                    <td>{date(s.settlement_date)}</td>
                    <td>
                      <a className="mono" href={`/settlements/${s.id}`}>
                        {s.id}
                      </a>
                    </td>
                    <td>
                      <Badge status={s.status} />
                    </td>
                    <td className="num">{count(s.entry_count)}</td>
                    <td className="num">{money(s.gross, s.currency)}</td>
                    <td className="num">{money(s.fees + s.tax, s.currency)}</td>
                    <td className="num">{money(s.amount, s.currency)}</td>
                    <td className="num">
                      {money(s.payout_amount, s.payout_currency)}
                      {s.fx_rate && <div className="muted">@ {s.fx_rate.replace(/0+$/, "")}</div>}
                    </td>
                    <td className="mono">{s.utr ?? "—"}</td>
                    <td>
                      <a href={`/settlements/${s.id}/report`}>CSV</a>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <Pager basePath="/settlements" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
