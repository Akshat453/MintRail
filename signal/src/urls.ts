/**
 * Webhook URL policy. Production: https only, no private/loopback/link-local
 * targets (SSRF). dev/test additionally allow http to localhost, 127.0.0.1 and
 * host.docker.internal so local receivers work.
 */
import { isIP } from "node:net";

import { InvalidRequestError } from "@mintrail/shared";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal", "[::1]"]);

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

export function validateEndpointUrl(raw: string, allowLocal: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InvalidRequestError("url must be an absolute URL", { param: "url" });
  }
  if (raw.length > 500) throw new InvalidRequestError("url must be at most 500 characters", { param: "url" });
  if (u.username || u.password) throw new InvalidRequestError("url must not contain credentials", { param: "url" });
  const local = LOCAL_HOSTS.has(u.hostname);
  if (local && allowLocal && (u.protocol === "http:" || u.protocol === "https:")) return u.toString();
  if (u.protocol !== "https:") throw new InvalidRequestError("url must use https://", { param: "url" });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (local || (isIP(host) !== 0 && isPrivateAddress(host))) {
    throw new InvalidRequestError("url must not point at a private or loopback address", { param: "url" });
  }
  return u.toString();
}
