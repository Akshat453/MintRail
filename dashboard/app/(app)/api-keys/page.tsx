import { randomUUID } from "node:crypto";

import { dateTime } from "@mintrail/web";
import { Badge, Card, Field, Flash, PageHeader } from "@mintrail/web/ui";

import { createApiKey, revokeApiKey } from "@/app/actions";
import { SecretForm, Submit } from "@/components/client";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "API keys" };

export default async function KeysPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, user, csrf] = await Promise.all([searchParams, me(), csrfToken()]);
  const keys = await load((a) => a.get("/dashboard/v1/api_keys"));
  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Test keys use Bearer auth; live keys must sign every request (MintRail-Key-Id + MintRail-Signature)."
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <div className="grid grid-2">
        <Card title="Keys">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map(
                (k: { id: string; hint: string; mode: string; status: string; label: string | null; last_used_at: string | null }) => (
                  <tr key={k.id}>
                    <td>
                      <span className="mono">{k.hint}</span>
                      <div className="muted">
                        {k.label ?? "—"} · {k.id}
                      </div>
                    </td>
                    <td>{k.mode}</td>
                    <td>
                      <Badge status={k.status} />
                    </td>
                    <td>{dateTime(k.last_used_at)}</td>
                    <td>
                      {k.status === "active" && (
                        <form action={revokeApiKey}>
                          <input type="hidden" name="csrf" value={csrf} />
                          <input type="hidden" name="idem" value={randomUUID()} />
                          <input type="hidden" name="key_id" value={k.id} />
                          <Submit variant="secondary" confirm="Revoke this key? Requests using it fail immediately.">
                            Revoke
                          </Submit>
                        </form>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </Card>
        <Card title="Create a key">
          <SecretForm action={createApiKey} csrf={csrf} idem={randomUUID()} button="Create key" what="API key">
            <Field label="Label">
              <input name="label" maxLength={100} placeholder="Checkout service" />
            </Field>
            <Field label="Mode">
              <select name="mode" defaultValue="test">
                <option value="test">Test</option>
                {user.station.live_enabled && <option value="live">Live</option>}
              </select>
            </Field>
          </SecretForm>
        </Card>
      </div>
    </>
  );
}
