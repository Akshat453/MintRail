import { dateTime } from "@mintrail/web";
import { Badge, Card, Dl, Field, Flash, Mono, PageHeader } from "@mintrail/web/ui";

import { addDerailmentNote } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Derailment" };

export default async function DerailmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const [{ id }, sp, user, csrf] = await Promise.all([params, searchParams, me(), csrfToken()]);
  const d = await load((a) => a.get(`/internal/v1/derailments/${id}`));
  return (
    <>
      <PageHeader
        title={d.title}
        subtitle={<Mono>{d.id}</Mono>}
        actions={
          <>
            <Badge status={d.severity} /> <Badge status={d.status} />
          </>
        }
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card title="Summary">
        <p>{d.summary}</p>
        <Dl
          items={[
            ["Affected", d.affected.join(", ") || "—"],
            ["Commander", d.commander_id],
            ["Started", dateTime(d.started_at)],
            ["Resolved", dateTime(d.resolved_at)],
          ]}
        />
      </Card>
      <div className="grid grid-2">
        <Card title="Timeline">
          <ul className="timeline" data-testid="timeline">
            {d.notes.map((n: { id: bigint; body: string; staff_id: string; status_change: string | null; created_at: string }) => (
              <li key={String(n.id)}>
                {n.status_change && <Badge status={n.status_change} />} {n.body}
                <div className="muted">
                  {dateTime(n.created_at)} · {n.staff_id}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        {user.permissions.includes("derailments:write") && (
          <Card title="Add note">
            <form action={addDerailmentNote}>
              <Hidden csrf={csrf} values={{ derailment_id: d.id }} />
              <Field label="Note">
                <textarea name="body" required rows={4} maxLength={4000} />
              </Field>
              <Field label="Change status">
                <select name="status" defaultValue="">
                  <option value="">(no change)</option>
                  <option value="investigating">investigating</option>
                  <option value="mitigated">mitigated</option>
                  <option value="resolved">resolved</option>
                </select>
              </Field>
              <Submit>Add note</Submit>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
