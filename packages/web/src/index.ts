/** Formatting shared by the MintRail web apps. Money is always bigint minor units — never a float. */

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$" };

/** Indian digit grouping: 12,34,56,789. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

const groupWestern = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function money(minor: bigint | null | undefined, currency = "INR", opts: { sign?: boolean } = {}): string {
  if (minor === null || minor === undefined) return "—";
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const units = (abs / 100n).toString();
  const cents = String(abs % 100n).padStart(2, "0");
  const grouped = currency === "INR" ? groupIndian(units) : groupWestern(units);
  const s = `${SYMBOL[currency] ?? `${currency} `}${grouped}.${cents}`;
  return neg ? `−${s}` : opts.sign && minor > 0n ? `+${s}` : s;
}

/** Compact amounts for KPI tiles: ₹12.4L, ₹3.1Cr. */
export function moneyCompact(minor: bigint, currency = "INR"): string {
  const rupees = minor / 100n;
  if (currency !== "INR") return money(minor, currency);
  const tenths = (n: bigint, d: bigint) => {
    const scaled = (n * 10n) / d;
    return `${scaled / 10n}.${scaled % 10n}`;
  };
  if (rupees >= 1_00_00_000n) return `₹${tenths(rupees, 1_00_00_000n)}Cr`;
  if (rupees >= 1_00_000n) return `₹${tenths(rupees, 1_00_000n)}L`;
  if (rupees >= 1_000n) return `₹${tenths(rupees, 1_000n)}K`;
  return money(minor, currency);
}

export const count = (n: bigint | number): string => groupIndian(n.toString());

/** Basis points → "92.34%". */
export function percentBps(bps: bigint | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  return `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}%`;
}

const IST = "Asia/Kolkata";
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
export function date(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso),
  );
}
export const shortDate = (isoDay: string): string =>
  new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "2-digit", month: "short" }).format(new Date(`${isoDay}T12:00:00+05:30`));

export const label = (s: string | null | undefined): string => (s ? s.replaceAll("_", " ") : "—");

/** Rupees typed by a person ("1,499.50") → paise, without floats. Returns null if invalid. */
export function parseRupees(input: string): bigint | null {
  const t = input.replaceAll(",", "").replace(/^₹/, "").trim();
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

export const todayIst = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(d);
}
