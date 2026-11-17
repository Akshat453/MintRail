import { addDaysIso, todayIst } from "@mintrail/web";
import { Card, Field, PageHeader } from "@mintrail/web/ui";

export const metadata = { title: "Reports" };

const REPORTS: [string, string][] = [
  ["payments", "Every payment attempt with MDR fee and GST"],
  ["refunds", "Refunds with speed, reason and instant-refund fees"],
  ["settlements", "One row per settlement with gross, fees, GST, net and UTR"],
  ["payouts", "Freight payouts with status and UTR"],
];

export default function ReportsPage() {
  const to = todayIst();
  const from = addDaysIso(to, -29);
  return (
    <>
      <PageHeader title="Reports" subtitle="CSV exports for your finance team (IST dates, amounts in rupees)." />
      <div className="grid grid-2">
        {REPORTS.map(([kind, desc]) => (
          <Card key={kind} title={`${kind[0]!.toUpperCase()}${kind.slice(1)}`}>
            <p className="muted">{desc}</p>
            <form method="get" action={`/reports/${kind}`} className="filters">
              <Field label="From">
                <input type="date" name="from" defaultValue={from} required />
              </Field>
              <Field label="To">
                <input type="date" name="to" defaultValue={to} required />
              </Field>
              <button type="submit">Download CSV</button>
            </form>
          </Card>
        ))}
      </div>
    </>
  );
}
