import type { SupportedLocale } from "@/i18n/types";
import type { TimePoint } from "@/domain/shared/temporal";

/**
 * Locale display of recorded dates and times. Values are shown exactly as
 * recorded: a local date is never shifted by the device timezone.
 */

const HOME_TIME_ZONE = "Asia/Singapore";

/** "3 Nov 2026" / "2026年11月3日". */
export function formatLocalDate(locale: SupportedLocale, localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** The local calendar date of a recorded time point, or null when unknown. */
export function localDateOfPoint(point: TimePoint): string | null {
  if (point.kind === "DATE_ONLY") return point.localDate;
  if (point.kind === "UNKNOWN") return null;
  const instant = point.kind === "EXACT" ? point.instantUtc : point.approximateInstantUtc;
  return new Intl.DateTimeFormat("en-CA", { timeZone: point.timeZoneId ?? HOME_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

/** Clock time of an exact or approximate point in its recorded timezone. */
export function formatPointTime(locale: SupportedLocale, point: TimePoint): string | null {
  if (point.kind !== "EXACT" && point.kind !== "APPROXIMATE") return null;
  const instant = point.kind === "EXACT" ? point.instantUtc : point.approximateInstantUtc;
  return new Intl.DateTimeFormat(locale, { timeZone: point.timeZoneId ?? HOME_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}

export function formatWeekday(locale: SupportedLocale, localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatMonthShort(locale: SupportedLocale, localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Whole calendar days from one local date to another (never a clinical interval). */
export function daysBetween(fromLocalDate: string, toLocalDate: string): number {
  return Math.round((Date.parse(`${toLocalDate}T00:00:00.000Z`) - Date.parse(`${fromLocalDate}T00:00:00.000Z`)) / 86_400_000);
}

/** Today's local date in the home timezone. */
export function homeLocalDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
