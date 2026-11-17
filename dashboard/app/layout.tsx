import "@mintrail/web/styles.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "MintRail Dashboard", template: "%s · MintRail" },
  description: "Payments, refunds, settlements and webhooks for your MintRail account.",
  robots: { index: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
