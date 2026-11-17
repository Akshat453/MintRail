/** CSV download, proxied server-side so the session token never reaches the browser. */
import { api } from "@/lib/session";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!/^stl_[0-9a-z]{26}$/.test(id)) return new Response("Not found", { status: 404 });
  const res = await (await api()).raw(`/dashboard/v1/settlements/${id}/report`);
  if (!res.ok) return new Response("Settlement report unavailable", { status: res.status });
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": res.headers.get("content-disposition") ?? `attachment; filename="${id}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
