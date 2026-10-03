import type { SupportedLocale } from "@/domain/patient-settings/locale";

/**
 * Pure locale formatting for recorded local dates and clock times. Values are
 * already local to the recorded timezone, so they are formatted in UTC and
 * never shifted by the device timezone.
 */

function localDateParts(localDate: string): [number, number, number] {
  return localDate.split("-").map(Number) as [number, number, number];
}

/** "Sat, 3 Oct" / "10月3日周六". */
export function formatScheduleDate(locale: SupportedLocale, localDate: string): string {
  const [year, month, day] = localDateParts(localDate);
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** "3 Oct" / "10月3日". */
export function formatScheduleDay(locale: SupportedLocale, localDate: string): string {
  const [year, month, day] = localDateParts(localDate);
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** A recorded HH:mm clock time in the locale's convention: "9:00 pm" / "下午9:00". */
export function formatScheduleTime(locale: SupportedLocale, time: string): string {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}

/** An instant's clock time in the home timezone (Asia/Singapore). */
export function formatInstantTime(locale: SupportedLocale, instant: string, timeZone = "Asia/Singapore"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}
