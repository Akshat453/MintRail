import { date } from "@mintrail/web";
import { Badge, Card, Empty, PageHeader, Pager } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Merchants" };

export default async function MerchantsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = { q: one(sp.q), kyc_status: one(sp.kyc_status), starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/internal/v1/stations", { ...params, limit: "25" }));
  return (
    <>
      <PageHeader title="Merchant lookup" subtitle="Search by name, email or mer_ id." />
      <Card>
        <form className="filters" method="get">
          <input name="q" defaultValue={params.q} placeholder="Kesari, finance@…, mer_…" size={34} />
          <select name="kyc_status" defaultValue={params.kyc_status ?? ""}>
            <option value="">Any KYC</option>
            <option>pending</option>
            <option>verified</option>
            <option>rejected</option>
          </select>
          <button type="submit">Search</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No merchants found.</Empty>
        ) : (
          <table data-testid="merchants">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Plan</th>
                <th>Schedule</th>
                <th>KYC</th>
                <th>Status</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (s: {
                  id: string;
                  display_name: string;
                  email: string;
                  kyc_status: string;
                  status: string;
                  created_at: string;
                  settings: { fee_plan: string; settlement_schedule: string };
                }) => (
                  <tr key={s.id}>
                    <td>
                      <a href={`/merchants/${s.id}`}>{s.display_name}</a>
                      <div className="muted mono">{s.id}</div>
                    </td>
                    <td>{s.settings.fee_plan}</td>
                    <td>{s.settings.settlement_schedule}</td>
                    <td>
                      <Badge status={s.kyc_status} />
                    </td>
                    <td>
                      <Badge status={s.status} />
                    </td>
                    <td>{date(s.created_at)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <Pager basePath="/merchants" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
