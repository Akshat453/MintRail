import { dateTime } from "@mintrail/web";
import { Badge, Empty } from "@mintrail/web/ui";

export function Deliveries({
  rows,
}: {
  rows: {
    id: string;
    event_type: string;
    event_id: string;
    status: string;
    attempts: bigint;
    last_status_code: bigint | null;
    created_at: string;
    endpoint_id: string;
  }[];
}) {
  if (rows.length === 0) return <Empty>No deliveries yet.</Empty>;
  return (
    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Status</th>
          <th className="num">Attempts</th>
          <th className="num">Last HTTP</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id}>
            <td>
              <strong>{d.event_type}</strong>
              <div className="mono muted">{d.event_id}</div>
            </td>
            <td>
              <Badge status={d.status} />
            </td>
            <td className="num">{d.attempts.toString()}</td>
            <td className="num">{d.last_status_code?.toString() ?? "—"}</td>
            <td>{dateTime(d.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
