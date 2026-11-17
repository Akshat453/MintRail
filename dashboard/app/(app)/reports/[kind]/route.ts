import { api } from "@/lib/session";

const KINDS = new Set(["payments", "refunds", "settlements", "payouts"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }): Promise<Response> {
  const { kind } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  if (!KINDS.has(kind) || !DAY.test(from) || !DAY.test(to)) return new Response("Bad report request", { status: 400 });
  const res = await (await api()).raw(`/dashboard/v1/reports/${kind}`, { from, to });
  if (!res.ok) return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": res.headers.get("content-disposition") ?? `attachment; filename="${kind}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
