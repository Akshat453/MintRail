import { randomUUID } from "node:crypto";

import { dateTime } from "@mintrail/web";
import { Badge, Card, Field, Flash, PageHeader } from "@mintrail/web/ui";

import { createApiKey, revokeApiKey, rotateApiKey } from "@/app/actions";
import { SecretForm, Submit } from "@/components/client";
import { csrfToken, load, me, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "API keys" };

export default async function KeysPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, user, csrf] = await Promise.all([searchParams, me(), csrfToken()]);
  const keys = await load((a) =>
    a.get<{ data: { id: string; hint: string; mode: string; status: string; label: string | null; last_used_at: string | null }[] }>(
      "/dashboard/v1/api_keys",
    ),
  );
  const active = keys.data.filter((k) => k.status === "active");
  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Test keys use Bearer auth; live keys must sign every request (MintRail-Key-Id + MintRail-Signature)."
      />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card title="Keys" actions={<span className="muted">{active.length} active</span>}>
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
            {keys.data.map((k) => (
              <tr key={k.id}>
                <td>
                  <span className="mono">{k.hint}</span>
                  <div className="muted">
                    {k.label ?? "—"} · {k.id}
                  </div>
                </td>
                <td>
                  <span className={`pill ${k.mode === "live" ? "pill-live" : "pill-test"}`}>{k.mode.toUpperCase()}</span>
                </td>
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
            ))}
          </tbody>
        </table>
      </Card>
      <div className="grid grid-2">
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
        <Card title="Rotate a key">
          {active.length === 0 ? (
            <p className="muted">No active keys to rotate.</p>
          ) : (
            <SecretForm action={rotateApiKey} csrf={csrf} idem={randomUUID()} button="Rotate key" what="Replacement key">
              <Field
                label="Key to replace"
                hint="The new key gets the same mode and label. The old key keeps working for a grace period so you can deploy the new one."
              >
                <select name="key_id" defaultValue={active[0]!.id}>
                  {active.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label ?? "Unnamed key"} · {k.mode} · {k.id}
                    </option>
                  ))}
                </select>
              </Field>
            </SecretForm>
          )}
        </Card>
      </div>
    </>
  );
}
