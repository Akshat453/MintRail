import { dateTime } from "@mintrail/web";
import { Card, Empty, PageHeader } from "@mintrail/web/ui";

import { load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = { target_id: one(sp.target_id), staff_id: one(sp.staff_id), starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/internal/v1/audit_log", { ...params, limit: "100" }));
  const last = page.data.at(-1)?.id;
  return (
    <>
      <PageHeader title="Staff audit log" subtitle="Append-only (the database rejects updates and deletes)." />
      <Card>
        <form className="filters" method="get">
          <input name="target_id" defaultValue={params.target_id} placeholder="Target id (mer_…, pout_…)" />
          <input name="staff_id" defaultValue={params.staff_id} placeholder="stf_…" />
          <button type="submit">Filter</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No entries.</Empty>
        ) : (
          <table data-testid="audit">
            <thead>
              <tr>
                <th>When (IST)</th>
                <th>Staff</th>
                <th>Action</th>
                <th>Target</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (e: {
                  id: bigint;
                  created_at: string;
                  staff_email: string;
                  action: string;
                  target_type: string | null;
                  target_id: string | null;
                  ip: string | null;
                }) => (
                  <tr key={String(e.id)}>
                    <td>{dateTime(e.created_at)}</td>
                    <td>{e.staff_email}</td>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td className="mono">{e.target_id ? `${e.target_type}:${e.target_id}` : "—"}</td>
                    <td className="mono">{e.ip ?? ""}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        {page.has_more && last !== undefined && (
          <p>
            <a href={`/audit?starting_after=${last}`}>Older entries →</a>
          </p>
        )}
      </Card>
    </>
  );
}
