import { dateTime } from "@mintrail/web";
import { Badge, Card, Empty, Flash, PageHeader, Pager } from "@mintrail/web/ui";

import { replayDelivery } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Webhook replay" };

export default async function WebhooksPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, csrf] = await Promise.all([searchParams, csrfToken()]);
  const params = { status: one(sp.status) ?? "failed", station_id: one(sp.station_id), starting_after: one(sp.starting_after) };
  const page = await load((a) => a.get("/internal/v1/webhook_deliveries", { ...params, limit: "30" }));
  return (
    <>
      <PageHeader
        title="Webhook deliveries"
        subtitle="Find deliveries that exhausted their retries and replay them once the merchant's endpoint is healthy."
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card>
        <form className="filters" method="get">
          <select name="status" defaultValue={params.status}>
            <option value="failed">failed</option>
            <option value="pending">pending</option>
            <option value="succeeded">succeeded</option>
          </select>
          <input name="station_id" defaultValue={params.station_id} placeholder="mer_…" />
          <button type="submit">Search</button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No deliveries match.</Empty>
        ) : (
          <table data-testid="deliveries">
            <thead>
              <tr>
                <th>Delivery</th>
                <th>Merchant</th>
                <th>Event</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Last error</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (d: {
                  id: string;
                  station_id: string;
                  event_type: string;
                  status: string;
                  attempts: bigint;
                  last_error: string | null;
                  created_at: string;
                }) => (
                  <tr key={d.id}>
                    <td className="mono">{d.id}</td>
                    <td>
                      <a className="mono" href={`/merchants/${d.station_id}`}>
                        {d.station_id}
                      </a>
                    </td>
                    <td>{d.event_type}</td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                    <td className="num">{d.attempts.toString()}</td>
                    <td className="muted">{d.last_error ?? ""}</td>
                    <td>{dateTime(d.created_at)}</td>
                    <td>
                      <form action={replayDelivery}>
                        <Hidden csrf={csrf} values={{ delivery_id: d.id, back: "/webhooks" }} />
                        <Submit variant="secondary">Replay</Submit>
                      </form>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <Pager basePath="/webhooks" params={params} lastId={page.data.at(-1)?.id} hasMore={page.has_more} />
      </Card>
    </>
  );
}
