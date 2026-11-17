import { dateTime } from "@mintrail/web";
import { Card, Empty, Flash, PageHeader } from "@mintrail/web/ui";

import { kycDecision } from "@/app/actions";
import { Submit } from "@/components/client";
import { Hidden } from "@/components/hidden";
import { csrfToken, load, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "KYC queue" };

export default async function KycPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, csrf] = await Promise.all([searchParams, csrfToken()]);
  const page = await load((a) => a.get("/internal/v1/stations", { kyc_status: "pending", limit: "100" }));
  return (
    <>
      <PageHeader title="KYC review queue" subtitle="Verifying KYC unlocks live mode (live keys, live ledger accounts)." />
      <Flash msg={one(sp.msg)} err={one(sp.err)} />
      <Card>
        {page.data.length === 0 ? (
          <Empty>Queue is empty.</Empty>
        ) : (
          <table data-testid="kyc-queue">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>MCC</th>
                <th>Applied</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map(
                (s: {
                  id: string;
                  legal_name: string;
                  display_name: string;
                  email: string;
                  business_category: string;
                  created_at: string;
                }) => (
                  <tr key={s.id}>
                    <td>
                      <a href={`/merchants/${s.id}`}>{s.display_name}</a>
                      <div className="muted">
                        {s.legal_name} · {s.email}
                      </div>
                    </td>
                    <td>{s.business_category}</td>
                    <td>{dateTime(s.created_at)}</td>
                    <td>
                      <div className="row">
                        <form action={kycDecision}>
                          <Hidden csrf={csrf} values={{ station_id: s.id, decision: "verify" }} />
                          <Submit>Verify</Submit>
                        </form>
                        <form action={kycDecision} className="row">
                          <Hidden csrf={csrf} values={{ station_id: s.id, decision: "reject" }} />
                          <input name="reason" placeholder="Reason (min 3 chars)" minLength={3} required />
                          <Submit variant="danger">Reject</Submit>
                        </form>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
