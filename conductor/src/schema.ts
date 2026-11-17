/** Conductor-owned table. Names match docs/contract/schema-m1.sql. */
import { sql } from "drizzle-orm";
import { boolean, check, pgTable, primaryKey, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const conductorBlocklist = pgTable(
  "conductor_blocklist",
  {
    id: varchar("id", { length: 40 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    value: varchar("value", { length: 255 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    active: boolean("active").notNull(),
    createdBy: varchar("created_by", { length: 40 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    deactivatedAt: ts("deactivated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_conductor_blocklist", columns: [t.id] }),
    check("ck_conductor_blocklist_valid_kind", sql`kind IN ('card_bin','vpa')`),
    uniqueIndex("uq_conductor_blocklist_active_value")
      .on(t.kind, t.value)
      .where(sql`active`),
  ],
);

export type BlocklistEntry = typeof conductorBlocklist.$inferSelect;
export type BlocklistKind = "card_bin" | "vpa";
