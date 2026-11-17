import { date, dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Dl, Mono, PageHeader } from "@mintrail/web/ui";

import { load } from "@/lib/session";

export const metadata = { title: "Settlement" };

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [s, entries] = await load((a) =>
    Promise.all([a.get(`/dashboard/v1/settlements/${id}`), a.get(`/dashboard/v1/settlements/${id}/entries`)]),
  );
  const byKind = new Map<string, { n: number; amount: bigint }>();
  for (const e of entries.data as { kind: string; amount: bigint }[]) {
    const k = byKind.get(e.kind) ?? { n: 0, amount: 0n };
    k.n += 1;
    k.amount += e.amount;
    byKind.set(e.kind, k);
  }
  return (
    <>
      <PageHeader
        title={`${money(s.payout_amount, s.payout_currency)} on ${date(s.settlement_date)}`}
        subtitle={<Mono>{s.id}</Mono>}
        actions={
          <>
            <Badge status={s.status} />
            <a className="btn btn-sm" href={`/settlements/${s.id}/report`}>
              Download CSV
            </a>
          </>
        }
      />
      <Card title="Summary">
        <Dl
          items={[
            ["Schedule", s.schedule],
            ["Cutoff (IST)", dateTime(s.cutoff_at)],
            ["Gross", money(s.gross, s.currency)],
            ["MDR fees", money(s.fees, s.currency)],
            ["GST on fees (18%)", money(s.tax, s.currency)],
            ["Net settled", money(s.amount, s.currency)],
            ["FX", s.fx_rate ? `${s.currency}→INR @ ${s.fx_rate}` : "—"],
            ["UTR", s.utr ?? "pending"],
          ]}
        />
      </Card>
      <Card title="Breakdown">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Entries</th>
              <th className="num">Net effect</th>
            </tr>
          </thead>
          <tbody>
            {[...byKind].map(([k, v]) => (
              <tr key={k}>
                <td>{label(k)}</td>
                <td className="num">{v.n}</td>
                <td className="num">{money(v.amount, s.currency, { sign: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
