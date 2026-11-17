import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Dl, Flash, Mono, PageHeader } from "@mintrail/web/ui";

import { disputeAction } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Dispute" };

export default async function DisputePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const [{ id }, sp, user, csrf] = await Promise.all([params, searchParams, me(), csrfToken()]);
  const d = await load((a) => a.get(`/internal/v1/disputes/${id}`));
  const manage = user.permissions.includes("disputes:manage") && d.status === "needs_response";
  return (
    <>
      <PageHeader title={`Dispute · ${money(d.amount, d.currency)}`} subtitle={<Mono>{d.id}</Mono>} actions={<Badge status={d.status} />} />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card title="Case">
        <Dl
          items={[
            [
              "Merchant",
              <a key="m" className="mono" href={`/merchants/${d.station_id}`}>
                {d.station_id}
              </a>,
            ],
            ["Payment", <Mono key="p">{d.payment_id}</Mono>],
            ["Mode", d.livemode ? "live" : "test"],
            ["Reason", label(d.reason)],
            ["Network ref", d.network_reference],
            ["Due (IST)", dateTime(d.evidence_due_by)],
            ["Submitted", dateTime(d.evidence_submitted_at)],
            ["Outcome", d.outcome_reason ?? "—"],
          ]}
        />
      </Card>
      <Card title="Evidence">
        {d.evidence_text && <p style={{ whiteSpace: "pre-wrap" }}>{d.evidence_text}</p>}
        <ul>
          {d.evidence.map(
            (e: { id: string; filename: string; kind: string; content_type: string; uploaded_by: string; sha256: string }) => (
              <li key={e.id}>
                {e.filename}{" "}
                <span className="muted">
                  · {label(e.kind)} · {e.content_type} · by {e.uploaded_by} · sha256 {e.sha256.slice(0, 12)}…
                </span>
              </li>
            ),
          )}
        </ul>
        {d.evidence.length === 0 && !d.evidence_text && <p className="muted">The merchant has not uploaded evidence.</p>}
        {manage && (
          <div className="row">
            <form action={disputeAction}>
              <Hidden csrf={csrf} values={{ dispute_id: d.id, op: "submit" }} />
              <Submit>Submit on merchant&apos;s behalf</Submit>
            </form>
            <form action={disputeAction}>
              <Hidden csrf={csrf} values={{ dispute_id: d.id, op: "accept" }} />
              <Submit variant="danger" confirm="Accept the chargeback on the merchant's behalf?">
                Accept
              </Submit>
            </form>
          </div>
        )}
      </Card>
    </>
  );
}
