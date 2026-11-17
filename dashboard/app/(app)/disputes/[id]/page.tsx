import { randomUUID } from "node:crypto";

import { dateTime, label, money } from "@mintrail/web";
import { Badge, Card, Dl, Field, Flash, Mono, PageHeader } from "@mintrail/web/ui";

import { disputeAction, uploadEvidence } from "@/app/actions";
import { Submit } from "@/components/client";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Dispute" };

export default async function DisputePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const [{ id }, sp, user, csrf] = await Promise.all([params, searchParams, me(), csrfToken()]);
  const d = await load((a) => a.get(`/dashboard/v1/disputes/${id}`));
  const open = d.status === "needs_response" && user.permissions.includes("disputes");
  return (
    <>
      <PageHeader title={`Dispute · ${money(d.amount, d.currency)}`} subtitle={<Mono>{d.id}</Mono>} actions={<Badge status={d.status} />} />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card title="Case">
        <Dl
          items={[
            [
              "Payment",
              <a key="p" className="mono" href={`/payments/${d.payment_id}`}>
                {d.payment_id}
              </a>,
            ],
            ["Reason", label(d.reason)],
            ["Network reference", d.network_reference],
            ["Respond by (IST)", dateTime(d.evidence_due_by)],
            ["Evidence submitted", dateTime(d.evidence_submitted_at)],
            ["Outcome", d.outcome_reason ?? "—"],
          ]}
        />
      </Card>
      <div className="grid grid-2">
        <Card title="Evidence">
          {d.evidence_text && <p style={{ whiteSpace: "pre-wrap" }}>{d.evidence_text}</p>}
          {d.evidence.length === 0 && !d.evidence_text && <p className="muted">No evidence yet.</p>}
          <ul>
            {d.evidence.map((e: { id: string; filename: string; kind: string; size_bytes: bigint; content_type: string }) => (
              <li key={e.id}>
                {e.filename}{" "}
                <span className="muted">
                  · {label(e.kind)} · {e.content_type} · {(Number(e.size_bytes) / 1024).toFixed(0)} KB
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {open && (
          <Card title="Respond">
            <form action={uploadEvidence} className="stack" data-testid="evidence-form">
              <input type="hidden" name="csrf" value={csrf} />
              <input type="hidden" name="dispute_id" value={d.id} />
              <Field label="Evidence type">
                <select name="kind" defaultValue="receipt">
                  {["receipt", "shipping_proof", "customer_communication", "refund_policy", "other"].map((k) => (
                    <option key={k} value={k}>
                      {label(k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Files" hint="PDF, PNG or JPEG · up to 5 files · 5 MB each. Checked by content, not file name.">
                <input type="file" name="files" multiple accept="application/pdf,image/png,image/jpeg" />
              </Field>
              <Field label="Statement">
                <textarea
                  name="text"
                  rows={4}
                  maxLength={5000}
                  placeholder="What happened, with dates, tracking numbers, customer messages…"
                />
              </Field>
              <Submit variant="secondary">Save evidence</Submit>
            </form>
            <div className="row" style={{ marginTop: 14 }}>
              <form action={disputeAction}>
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="idem" value={randomUUID()} />
                <input type="hidden" name="dispute_id" value={d.id} />
                <input type="hidden" name="action" value="submit" />
                <Submit confirm="Submit the evidence to the card network? You can't add more afterwards.">Submit evidence</Submit>
              </form>
              <form action={disputeAction}>
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="idem" value={randomUUID()} />
                <input type="hidden" name="dispute_id" value={d.id} />
                <input type="hidden" name="action" value="accept" />
                <Submit variant="danger" confirm="Accept this dispute? The amount goes back to the cardholder.">
                  Accept dispute
                </Submit>
              </form>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
