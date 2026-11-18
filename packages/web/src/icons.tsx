/** Small stroke icon set (24×24 grid, currentColor). Usable from server and client components. */
import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19M6.5 15h4" />
    </>
  ),
  refund: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  bank: (
    <>
      <path d="M3 9.5 12 4l9 5.5M4.5 10v8M9.5 10v8M14.5 10v8M19.5 10v8M3 20.5h18" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z" />
      <path d="M12 8v4.5M12 15.8v.2" />
    </>
  ),
  send: (
    <>
      <path d="M21 3 10 14" />
      <path d="M21 3l-7 18-4-7-7-4z" />
    </>
  ),
  webhook: (
    <>
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <circle cx="12" cy="6" r="2.5" />
      <path d="M8.5 17h7M10.8 8.2 7.3 14.8M13.2 8.2l3.5 6.6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.2 11.8 8.8-8.8M16.5 6.5l2.5 2.5M14 9l2 2" />
    </>
  ),
  report: (
    <>
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3v5h5M9 17v-3M12 17v-6M15 17v-4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.8 2.7 2.6 3 5.2" />
    </>
  ),
  check: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12.5 2.8 2.8L16.5 9.5" />
    </>
  ),
  store: (
    <>
      <path d="M4 9.5V20h16V9.5M3 4h18l-1.5 5.5a2.5 2.5 0 0 1-4.75 0 2.5 2.5 0 0 1-4.75 0 2.5 2.5 0 0 1-4.75 0z" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  alert: (
    <>
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4M12 17v.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M10 16.5 14.5 12 10 7.5M14.5 12H4" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  ok: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  rotate: (
    <>
      <path d="M20 11a8 8 0 0 0-14.7-4.3L3.5 9" />
      <path d="M3.5 4v5h5M4 13a8 8 0 0 0 14.7 4.3L20.5 15" />
      <path d="M20.5 20v-5h-5" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name] ?? PATHS.dot}
    </svg>
  );
}
