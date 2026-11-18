"use client";
import { usePathname } from "next/navigation";

import { Icon } from "@mintrail/web/icons";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function Submit({ children, variant, confirm }: { children: ReactNode; variant?: "secondary" | "danger"; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={variant ? `btn-${variant} btn-sm` : "btn-sm"}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/** Sidebar navigation. Items are [href, label, icon]; a string item starts a new section. */
export function NavLinks({ items }: { items: ([string, string, string] | string)[] }) {
  const path = usePathname();
  return (
    <nav className="nav">
      {items.map((item) =>
        typeof item === "string" ? (
          <div key={item} className="nav-label">
            {item}
          </div>
        ) : (
          <a
            key={item[0]}
            href={item[0]}
            className={(item[0] === "/" ? path === "/" : path.startsWith(item[0])) ? "active" : undefined}
            aria-current={(item[0] === "/" ? path === "/" : path.startsWith(item[0])) ? "page" : undefined}
          >
            <Icon name={item[2]} />
            {item[1]}
          </a>
        ),
      )}
    </nav>
  );
}
