/**
 * India Standard Time helpers (Asia/Kolkata, via Luxon's IANA zone support).
 * Business dates are ISO ``YYYY-MM-DD`` strings; instants are JS ``Date``s.
 */
import { DateTime } from "luxon";

export const IST = "Asia/Kolkata";

/** The IST calendar date of an instant. */
export const istDate = (at: Date): string => DateTime.fromJSDate(at, { zone: IST }).toISODate()!;

/** Midnight IST at the start of ``date`` as an instant. */
export const istStartOf = (date: string): Date => DateTime.fromISO(date, { zone: IST }).startOf("day").toJSDate();

/** ``date`` ± ``days`` (calendar arithmetic in IST). */
export const addDays = (date: string, days: number): string => DateTime.fromISO(date, { zone: IST }).plus({ days }).toISODate()!;

/**
 * The instant at which business day ``date`` closes, for a daily cutoff of
 * ``cutoffHour``:00 IST. With cutoff 0 the day closes at the next midnight;
 * with cutoff 18 it closes at 18:00 IST on ``date`` itself (later activity
 * belongs to the next business day).
 */
export function businessDayEnd(date: string, cutoffHour: number): Date {
  const day = DateTime.fromISO(date, { zone: IST }).startOf("day");
  return (cutoffHour === 0 ? day.plus({ days: 1 }) : day.set({ hour: cutoffHour })).toJSDate();
}

/** The business day an instant belongs to, for the same cutoff rule. */
export function businessDayOf(at: Date, cutoffHour: number): string {
  const t = DateTime.fromJSDate(at, { zone: IST });
  return (cutoffHour > 0 && t.hour >= cutoffHour ? t.plus({ days: 1 }) : t).toISODate()!;
}
