/** Minimal HTTP client + an independent implementation of MintRail request signing. */
import { createHash, createHmac } from "node:crypto";

/** JSON with exact money: bigint serialises as a bare JSON number. */
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "bigint" ? (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(x.toString()) : x,
  );

export interface Resp {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
}

export interface SendOptions {
  headers?: Record<string, string>;
  /** Raw body bytes; when given, `json` is ignored. */
  raw?: string;
  json?: unknown;
}

export async function send(base: string, method: string, path: string, opts: SendOptions = {}): Promise<Resp> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined = opts.raw;
  if (body === undefined && opts.json !== undefined) {
    body = toJson(opts.json);
  }
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json") && text.length > 0) {
    parsed = JSON.parse(text);
  }
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: out, body: parsed, text };
}

const SIGNING_CONTEXT = "mintrail-request-signing-v1";

export function signingKey(secret: string): Buffer {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(SIGNING_CONTEXT).digest();
}

export function signHeaders(
  secret: string,
  keyId: string,
  method: string,
  pathWithQuery: string,
  body: string,
  timestamp: number,
): Record<string, string> {
  const [path, query = ""] = pathWithQuery.split("?", 2) as [string, string?];
  const canonical = [method.toUpperCase(), path, query, createHash("sha256").update(body, "utf8").digest("hex")].join("\n");
  const sig = createHmac("sha256", signingKey(secret)).update(`${timestamp}.${canonical}`).digest("hex");
  return { "MintRail-Key-Id": keyId, "MintRail-Signature": `t=${timestamp},v1=${sig}` };
}

export function signCallback(secret: string, timestamp: number, payload: string): string {
  const v1 = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
