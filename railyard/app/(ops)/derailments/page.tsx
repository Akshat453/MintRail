import { dateTime } from "@mintrail/web";
import { Badge, Card, Empty, Field, Flash, PageHeader } from "@mintrail/web/ui";

import { openDerailment } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Derailments" };

export default async function DerailmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, user, csrf] = await Promise.all([searchParams, me(), csrfToken()]);
  const page = await load((a) => a.get("/internal/v1/derailments", { limit: "100" }));
  return (
    <>
      <PageHeader title="Derailments" subtitle="Incidents and their timelines. Anything logging DERAILMENT: pages on-call." />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <div className="grid grid-2">
        <Card title="Incidents">
          {page.data.length === 0 ? (
            <Empty>No incidents. Quiet rails.</Empty>
          ) : (
            <table data-testid="derailments">
              <tbody>
                {page.data.map((d: { id: string; title: string; severity: string; status: string; started_at: string }) => (
                  <tr key={d.id}>
                    <td>
                      <Badge status={d.severity} />
                    </td>
                    <td>
                      <a href={`/derailments/${d.id}`}>{d.title}</a>
                      <div className="muted">{dateTime(d.started_at)}</div>
                    </td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {user.permissions.includes("derailments:write") && (
          <Card title="Open a Derailment">
            <form action={openDerailment}>
              <Hidden csrf={csrf} />
              <Field label="Title">
                <input name="title" required minLength={5} maxLength={200} />
              </Field>
              <Field label="Severity">
                <select name="severity" defaultValue="sev3">
                  <option value="sev1">SEV1 — money at risk / full outage</option>
                  <option value="sev2">SEV2 — major degradation</option>
                  <option value="sev3">SEV3 — partial impact</option>
                  <option value="sev4">SEV4 — minor</option>
                </select>
              </Field>
              <Field label="Summary">
                <textarea name="summary" required minLength={5} rows={3} />
              </Field>
              <Field label="Affected (comma-separated)">
                <input name="affected" placeholder="junction, upi" />
              </Field>
              <Submit>Open incident</Submit>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
