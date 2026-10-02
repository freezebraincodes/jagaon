import type { SupportedLocale } from "@/i18n/types";
import type { Instant } from "@/domain/shared/time";

/**
 * Packet 6 journal forms record exact Singapore wall-clock occurrences.
 * Every date/time default and conversion goes through this module so the
 * form's displayed values and the stored +08:00 instant always agree, even
 * when the browser runs in another time zone.
 */

export const SINGAPORE_TIME_ZONE = "Asia/Singapore";
const SINGAPORE_OFFSET_MINUTES = 480;

export type SingaporeDateTimeParts = {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:mm` (24-hour) */
  time: string;
};

export function toSingaporeParts(instant: Date | string): SingaporeDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SINGAPORE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

export function singaporeNowParts(now: Date = new Date()): SingaporeDateTimeParts {
  return toSingaporeParts(now);
}

/** Returns null when the wall-clock values do not form a real instant. */
export function singaporeWallClockToInstant(
  date: string,
  time: string,
): Instant | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const parsed = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const instant = parsed.toISOString() as Instant;
  // Reject rolled-over values such as 2026-02-30.
  const roundTrip = toSingaporeParts(instant);
  return roundTrip.date === date && roundTrip.time === time ? instant : null;
}

export function exactSingaporeOccurrence(instantUtc: Instant) {
  return {
    kind: "POINT" as const,
    occurrence: {
      kind: "EXACT" as const,
      instantUtc,
      timeZoneId: SINGAPORE_TIME_ZONE,
      utcOffsetMinutes: SINGAPORE_OFFSET_MINUTES,
    },
  };
}

export function isSameSingaporeDay(instant: string, now: Date = new Date()): boolean {
  return toSingaporeParts(instant).date === toSingaporeParts(now).date;
}

export function singaporeHour(instant: string): number {
  return Number(toSingaporeParts(instant).time.slice(0, 2));
}

export function formatSingaporeTime(locale: SupportedLocale, instant: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: SINGAPORE_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
}

export function formatSingaporeDateTime(locale: SupportedLocale, instant: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: SINGAPORE_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
}

export function formatSingaporeLongDate(locale: SupportedLocale, now: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: SINGAPORE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);
}

/** "Today, 7:48 am" / "Yesterday, …" / full date for anything older. */
export function formatRelativeSingaporeTime(
  locale: SupportedLocale,
  instant: string,
  labels: { todayAt: (time: string) => string; yesterdayAt: (time: string) => string },
  now: Date = new Date(),
): string {
  const time = formatSingaporeTime(locale, instant);
  const day = toSingaporeParts(instant).date;
  if (day === toSingaporeParts(now).date) return labels.todayAt(time);
  if (day === shiftSingaporeDate(toSingaporeParts(now).date, -1)) return labels.yesterdayAt(time);
  return formatSingaporeDateTime(locale, instant);
}

/** Adds whole days to a `YYYY-MM-DD` Singapore calendar date. */
export function shiftSingaporeDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}
