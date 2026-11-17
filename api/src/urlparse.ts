/** The slice of Python's ``urllib.parse.urlparse`` used by webhook validation. */
export function urlparse(url: string): { scheme: string; hostname: string | null } {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  const scheme = m ? m[1]!.toLowerCase() : "";
  const rest = m ? m[2]! : url;
  if (!rest.startsWith("//")) return { scheme, hostname: null };
  const netloc = rest.slice(2).split(/[/?#]/, 1)[0] ?? "";
  let host = netloc.includes("@") ? netloc.slice(netloc.lastIndexOf("@") + 1) : netloc;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else if (host.includes(":")) {
    host = host.slice(0, host.indexOf(":"));
  }
  return { scheme, hostname: host ? host.toLowerCase() : null };
}
