import type { SupportedLocale } from "@/i18n/types";
import type { HistoryDisplayPosition, HistoryPeriod } from "@/application/history/recorded-history-contracts";

/**
 * Deterministic locale formatting for Recorded-history calendar dates
 * (YYYY-MM-DD, already in the demo's home timezone). Fixed tables keep the
 * output identical across browsers and ICU versions; these are date
 * conventions, not product copy.
 */

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EN_WEEKDAYS_NARROW = ["S", "M", "T", "W", "T", "F", "S"];
const ZH_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const ZH_WEEKDAYS_NARROW = ["日", "一", "二", "三", "四", "五", "六"];

type Parts = { year: number; month: number; day: number; weekday: number };

function parts(date: string): Parts {
  const value = new Date(`${date}T00:00:00Z`);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth(), day: value.getUTCDate(), weekday: value.getUTCDay() };
}

export function formatDateRange(locale: SupportedLocale, startDate: string, endDate: string): string {
  const a = parts(startDate);
  const b = parts(endDate);
  if (locale === "zh-SG") {
    const start = `${a.year}年${a.month + 1}月${a.day}日`;
    if (startDate === endDate) return start;
    if (a.year === b.year && a.month === b.month) return `${start}至${b.day}日`;
    if (a.year === b.year) return `${start}至${b.month + 1}月${b.day}日`;
    return `${start}至${b.year}年${b.month + 1}月${b.day}日`;
  }
  if (startDate === endDate) return `${a.day} ${EN_MONTHS[a.month]} ${a.year}`;
  if (a.year === b.year && a.month === b.month) return `${a.day}–${b.day} ${EN_MONTHS[b.month]} ${b.year}`;
  if (a.year === b.year) return `${a.day} ${EN_MONTHS[a.month]} – ${b.day} ${EN_MONTHS[b.month]} ${b.year}`;
  return `${a.day} ${EN_MONTHS[a.month]} ${a.year} – ${b.day} ${EN_MONTHS[b.month]} ${b.year}`;
}

/** Short day label: "Mon 28 Sep" / "9月28日周一". */
export function formatShortDate(locale: SupportedLocale, date: string): string {
  const p = parts(date);
  return locale === "zh-SG" ? `${p.month + 1}月${p.day}日${ZH_WEEKDAYS[p.weekday]}` : `${EN_WEEKDAYS_SHORT[p.weekday]} ${p.day} ${EN_MONTHS[p.month]}`;
}

/** A day split in two lines for a table row: { weekday: "Thu", date: "15 Oct" } / { weekday: "周四", date: "10月15日" }. */
export function formatDayParts(locale: SupportedLocale, date: string): { weekday: string; date: string } {
  const p = parts(date);
  return locale === "zh-SG"
    ? { weekday: ZH_WEEKDAYS[p.weekday]!, date: `${p.month + 1}月${p.day}日` }
    : { weekday: EN_WEEKDAYS_SHORT[p.weekday]!, date: `${p.day} ${EN_MONTHS[p.month]}` };
}

/**
 * Owner decision 2026-10-16: a chart day label in two lines, weekday over date: "Tue" / "13" for a week, "T" / "13" for 30 days
 * (each day has less room); "周二" / "13" and "二" / "13" in Chinese.
 */
export function formatChartDayLabel(locale: SupportedLocale, date: string, period: HistoryPeriod): { weekday: string; day: string } {
  const p = parts(date);
  const weekday =
    period === "THIRTY_DAYS"
      ? (locale === "zh-SG" ? ZH_WEEKDAYS_NARROW : EN_WEEKDAYS_NARROW)[p.weekday]!
      : (locale === "zh-SG" ? ZH_WEEKDAYS : EN_WEEKDAYS_SHORT)[p.weekday]!;
  return { weekday, day: `${p.day}` };
}

/** A display position named for the reader: "Wednesday evening" / "周三晚上". */
export function formatPosition(
  locale: SupportedLocale,
  date: string,
  position: HistoryDisplayPosition,
  period: HistoryPeriod,
  positionLabels: Record<HistoryDisplayPosition, string>,
): string {
  const p = parts(date);
  if (locale === "zh-SG") {
    const day = period === "THIRTY_DAYS" ? `${p.month + 1}月${p.day}日` : ZH_WEEKDAYS[p.weekday];
    return `${day}${positionLabels[position]}`;
  }
  const day = period === "THIRTY_DAYS" ? `${p.day} ${EN_MONTHS[p.month]}` : EN_WEEKDAYS_LONG[p.weekday];
  return `${day} ${positionLabels[position]}`;
}

/** "A and B" / "A, B and C"; zh-SG "A和B" / "A、B和C". */
export function formatList(locale: SupportedLocale, items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const head = items.slice(0, -1);
  const last = items.at(-1)!;
  return locale === "zh-SG" ? `${head.join("、")}和${last}` : `${head.join(", ")} and ${last}`;
}
