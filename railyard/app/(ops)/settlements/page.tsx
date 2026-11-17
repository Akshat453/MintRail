import { count, date, dateTime, money, todayIst } from "@mintrail/web";
import { Badge, Card, Empty, Field, Flash, PageHeader, Pager } from "@mintrail/web/ui";

import { runReconciliation, runSettlements } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Settlements" };

export default async function SettlementsPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, user, csrf] = await Promise.all([searchParams, me(), csrfToken()]);
  const params = { station_id: one(sp.station_id), starting_after: one(sp.starting_after) };
  const [page, recon] = await load((a) =>
    Promise.all([a.get("/internal/v1/settlements", { ...params, limit: "30" }), a.get("/internal/v1/reconciliation/latest")]),
  );
  const runner = user.permissions.includes("settlements:run");
  return (
    <>
      <PageHeader
        title="Settlements & reconciliation"
        subtitle="Depot settles every merchant daily (T+N, IST cutoff) and reconciles settlements against the ledger."
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <div className="grid grid-2">
        <Card title="Latest reconciliation">
          {recon.status === "never_run" ? (
            <p className="muted">Not run yet.</p>
          ) : (
            <>
              <p data-testid="recon">
                <Badge status={recon.status} /> <strong>{count(recon.mismatch_count)} mismatches</strong> · {count(recon.stations_checked)}{" "}
                merchants · {count(recon.settlements_checked)} settlements · {dateTime(recon.run_at)}
              </p>
              {recon.mismatches?.length > 0 && (
                <table>
                  <tbody>
                    {recon.mismatches.slice(0, 20).map(
                      (
                        m: {
                          check: string;
                          station_id: string | null;
                          reference_id: string | null;
                          expected: bigint | null;
                          actual: bigint | null;
                        },
                        i: number,
                      ) => (
                        <tr key={i}>
                          <td>{m.check}</td>
                          <td className="mono">{m.station_id ?? ""}</td>
                          <td className="mono">{m.reference_id ?? ""}</td>
                          <td className="num">{money(m.expected)}</td>
                          <td className="num">{money(m.actual)}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              )}
            </>
          )}
          {runner && (
            <form action={runReconciliation}>
              <Hidden csrf={csrf} />
              <Submit variant="secondary">Run reconciliation now</Submit>
            </form>
          )}
        </Card>
        {runner && (
          <Card title="Run settlements">
            <form action={runSettlements} className="row">
              <Hidden csrf={csrf} />
              <Field label="Business date (IST)">
                <input type="date" name="date" defaultValue={todayIst()} />
              </Field>
              <Submit>Queue run</Submit>
            </form>
            <p className="muted">Runs are idempotent per merchant and date; Depot also runs automatically every day.</p>
          </Card>
        )}
      </div>
      <Card title="Settlements">
        <form className="filters" method="get">
          <input name="station_id" defaultValue={params.station_id} placeholder="mer_…" />
          <button type="submit">Filter</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No settlements.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Settlement</th>
                <th>Merchant</th>
                <th>Status</th>
                <th className="num">Entries</th>
                <th className="num">Net</th>
                <th>UTR</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (s: {
                  id: string;
                  station_id: string;
                  settlement_date: string;
                  status: string;
                  entry_count: bigint;
                  payout_amount: bigint;
                  payout_currency: string;
                  utr: string | null;
                  livemode: boolean;
                }) => (
                  <tr key={s.id}>
                    <td>{date(s.settlement_date)}</td>
                    <td className="mono">{s.id}</td>
                    <td>
                      <a className="mono" href={`/merchants/${s.station_id}`}>
                        {s.station_id}
                      </a>
                    </td>
                    <td>
                      <Badge status={s.status} /> {!s.livemode && <span className="pill pill-test">test</span>}
                    </td>
                    <td className="num">{count(s.entry_count)}</td>
                    <td className="num">{money(s.payout_amount, s.payout_currency)}</td>
                    <td className="mono">{s.utr ?? "—"}</td>
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
