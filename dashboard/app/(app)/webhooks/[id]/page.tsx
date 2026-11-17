import { randomUUID } from "node:crypto";

import { dateTime } from "@mintrail/web";
import { Badge, Card, Dl, Flash, Mono, PageHeader } from "@mintrail/web/ui";

import { replayDelivery, rotateWebhookSecret, updateWebhook } from "@/app/actions";
import { SecretForm, Submit } from "@/components/client";
import { csrfToken, load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Webhook endpoint" };

export default async function EndpointPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const [{ id }, sp, csrf] = await Promise.all([params, searchParams, csrfToken()]);
  const [ep, deliveries] = await load((a) =>
    Promise.all([
      a.get(`/dashboard/v1/webhook_endpoints/${id}`),
      a.get("/dashboard/v1/webhook_deliveries", { endpoint_id: id, limit: "30" }),
    ]),
  );
  const hidden = (op: string) => (
    <>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="endpoint_id" value={ep.id} />
      <input type="hidden" name="op" value={op} />
    </>
  );
  return (
    <>
      <PageHeader title={ep.url} subtitle={<Mono>{ep.id}</Mono>} actions={<Badge status={ep.status} />} />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <div className="grid grid-2">
        <Card title="Endpoint">
          <Dl
            items={[
              ["Events", ep.enabled_events.join(", ")],
              ["Signing secret", `whsec_…${ep.secret_hint}`],
              ["Rotated", dateTime(ep.secret_rotated_at)],
              ["Old secret valid until", dateTime(ep.previous_secret_expires_at)],
              ["Created", dateTime(ep.created_at)],
            ]}
          />
          <div className="row" style={{ marginTop: 14 }}>
            <form action={updateWebhook}>
              {hidden(ep.status === "enabled" ? "disable" : "enable")}
              <Submit variant="secondary">{ep.status === "enabled" ? "Disable" : "Enable"}</Submit>
            </form>
            <form action={updateWebhook}>
              {hidden("delete")}
              <Submit variant="danger" confirm="Delete this endpoint? Pending deliveries stop.">
                Delete
              </Submit>
            </form>
          </div>
        </Card>
        <Card title="Rotate signing secret">
          <p className="muted">
            The old secret keeps signing (a second v1=) for 24 hours so you can deploy the new one without dropping events.
          </p>
          <SecretForm
            action={rotateWebhookSecret}
            csrf={csrf}
            idem={randomUUID()}
            hidden={{ endpoint_id: ep.id }}
            button="Rotate secret"
            what="New signing secret"
          />
        </Card>
      </div>
      <Card title="Delivery log">
        <table data-testid="delivery-log">
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th className="num">Attempts</th>
              <th className="num">HTTP</th>
              <th>Last error</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deliveries.data.map(
              (d: {
                id: string;
                event_type: string;
                status: string;
                attempts: bigint;
                last_status_code: bigint | null;
                last_error: string | null;
                created_at: string;
                replay_of: string | null;
              }) => (
                <tr key={d.id}>
                  <td>
                    {d.event_type}
                    {d.replay_of && <div className="muted">replay of {d.replay_of}</div>}
                  </td>
                  <td>
                    <Badge status={d.status} />
                  </td>
                  <td className="num">{d.attempts.toString()}</td>
                  <td className="num">{d.last_status_code?.toString() ?? "—"}</td>
                  <td className="muted">{d.last_error ?? ""}</td>
                  <td>{dateTime(d.created_at)}</td>
                  <td>
                    <form action={replayDelivery}>
                      <input type="hidden" name="csrf" value={csrf} />
                      <input type="hidden" name="idem" value={randomUUID()} />
                      <input type="hidden" name="delivery_id" value={d.id} />
                      <input type="hidden" name="back" value={`/webhooks/${ep.id}`} />
                      <Submit variant="secondary">Replay</Submit>
                    </form>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
