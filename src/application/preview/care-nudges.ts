/**
 * PREVIEW ONLY (HSA-bounded mode OFF, owner decision 2026-10-14): which diabetes care checks are due by standard intervals.
 *
 * This is exactly the judgement the bounded app does not make ("Shows only what you entered. The app doesn't decide what is due."),
 * so nothing here is used while HSA-bounded mode is on. It reads only the completions the patient reported and applies one fixed,
 * versioned table of standard intervals; it never gives advice beyond the interval and its source, and every screen that shows the
 * result says to check with the care team.
 *
 * Rule `care-intervals-preview.1` (all dates are Singapore calendar dates):
 *  - Last done = the latest patient-reported completion for the check (any plan, or recorded without a plan). A completion dated after
 *    today is ignored. A completion with an unknown date never reaches this module.
 *  - No completion recorded: DUE ("No record yet").
 *  - Due date = last done + the interval in calendar months (a day missing from the target month falls back to that month's last day).
 *  - Today on or after the due date: DUE. Within the 30 days before the due date: DUE_SOON. Otherwise NOT_DUE.
 *  - HbA1c is "every 3–6 months": it is due at 6 months; the 3-month lower bound is shown in the cadence text only and is not a
 *    trigger, because how often within that range is the care team's call.
 *  - Only DUE counts towards the bell and the More badge; DUE_SOON is shown on its row only.
 *  - Flu vaccine (catalogue FLU_VACCINE) is left out: it is yearly but optional and seasonal, so a "due" alert would overstate it.
 *  - Entered target dates do not change the status: the status is the standard interval since the last recorded completion.
 */

export const CARE_INTERVALS_PREVIEW_VERSION = "care-intervals-preview.1";

/** Days before the due date in which a check shows as "due soon". */
export const DUE_SOON_WINDOW_DAYS = 30;

export type CareNudgeKey = "EYE_SCREENING" | "FOOT_CHECK" | "BLOOD_TEST";
export type CareNudgeCadence = "YEARLY" | "EVERY_3_TO_6_MONTHS";

export type CareInterval = Readonly<{
  /** Preventive care catalogue key (`preventive-care-catalogue.1`). */
  key: CareNudgeKey;
  intervalMonths: number;
  cadence: CareNudgeCadence;
}>;

/** Singapore guidance (MOH / HPB diabetes care): yearly eye and foot screening; HbA1c every 3–6 months. */
export const CARE_INTERVALS_PREVIEW: Readonly<{ version: string; source: "SG_MOH_HPB"; entries: readonly CareInterval[] }> = Object.freeze({
  version: CARE_INTERVALS_PREVIEW_VERSION,
  source: "SG_MOH_HPB",
  entries: Object.freeze([
    Object.freeze({ key: "EYE_SCREENING" as const, intervalMonths: 12, cadence: "YEARLY" as const }),
    Object.freeze({ key: "FOOT_CHECK" as const, intervalMonths: 12, cadence: "YEARLY" as const }),
    Object.freeze({ key: "BLOOD_TEST" as const, intervalMonths: 6, cadence: "EVERY_3_TO_6_MONTHS" as const }),
  ]),
});

/** One patient-reported completion, by catalogue key, on a Singapore calendar date (YYYY-MM-DD). */
export type ReportedCompletion = Readonly<{ catalogueEntryKey: string; localDate: string }>;

export type CareNudgeStatus = "DUE" | "DUE_SOON" | "NOT_DUE";
export type CareNudgeDueIn = Readonly<{ unit: "MONTHS" | "WEEKS" | "DAYS"; count: number }>;

export type CareNudge = Readonly<{
  key: CareNudgeKey;
  cadence: CareNudgeCadence;
  intervalMonths: number;
  status: CareNudgeStatus;
  /** Latest recorded completion (local date), or null when none was recorded. */
  lastDoneOn: string | null;
  /** Whole calendar months since the last completion; null without a record. */
  monthsSinceLastDone: number | null;
  /** Last done + interval; null without a record. */
  dueOn: string | null;
  /** Time left until the due date, for DUE_SOON and NOT_DUE; null when DUE. */
  dueIn: CareNudgeDueIn | null;
}>;

export type CareNudgeSummary = Readonly<{
  version: string;
  /** Today's Singapore date the summary was worked out for. */
  asOf: string;
  /** DUE first, then DUE_SOON, then NOT_DUE; ties keep the interval table order. */
  nudges: readonly CareNudge[];
  dueCount: number;
}>;

const HOME_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** Singapore calendar date of an instant. */
export function singaporeLocalDate(now: Date): string {
  return new Date(now.getTime() + HOME_OFFSET_MS).toISOString().slice(0, 10);
}

function parts(localDate: string): [number, number, number] {
  return localDate.split("-").map(Number) as [number, number, number];
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Calendar-month addition; a day missing from the target month falls back to that month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(localDate: string, months: number): string {
  const [year, month, day] = parts(localDate);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return format(targetYear, targetMonth, Math.min(day, lastDay));
}

/** Whole calendar months from one date to a later one: the largest k with addMonths(from, k) <= to (0 when to <= from). */
export function wholeMonthsBetween(from: string, to: string): number {
  const [fy, fm] = parts(from);
  const [ty, tm] = parts(to);
  let months = Math.max(0, (ty - fy) * 12 + (tm - fm));
  while (months > 0 && addMonths(from, months) > to) months -= 1;
  return months;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

function dueInFrom(today: string, dueOn: string): CareNudgeDueIn {
  const months = wholeMonthsBetween(today, dueOn);
  if (months >= 1) return { unit: "MONTHS", count: months };
  const days = daysBetween(today, dueOn);
  if (days >= 7) return { unit: "WEEKS", count: Math.floor(days / 7) };
  return { unit: "DAYS", count: days };
}

const STATUS_ORDER: Record<CareNudgeStatus, number> = { DUE: 0, DUE_SOON: 1, NOT_DUE: 2 };

export function computeCareNudges(completions: readonly ReportedCompletion[], now: Date): CareNudgeSummary {
  const today = singaporeLocalDate(now);
  const nudges = CARE_INTERVALS_PREVIEW.entries.map((interval): CareNudge => {
    const lastDoneOn =
      completions
        .filter((completion) => completion.catalogueEntryKey === interval.key && completion.localDate <= today)
        .map((completion) => completion.localDate)
        .sort()
        .at(-1) ?? null;
    const base = { key: interval.key, cadence: interval.cadence, intervalMonths: interval.intervalMonths, lastDoneOn };
    if (lastDoneOn === null) return { ...base, status: "DUE", monthsSinceLastDone: null, dueOn: null, dueIn: null };
    const dueOn = addMonths(lastDoneOn, interval.intervalMonths);
    const monthsSinceLastDone = wholeMonthsBetween(lastDoneOn, today);
    if (today >= dueOn) return { ...base, status: "DUE", monthsSinceLastDone, dueOn, dueIn: null };
    const status = daysBetween(today, dueOn) <= DUE_SOON_WINDOW_DAYS ? "DUE_SOON" : "NOT_DUE";
    return { ...base, status, monthsSinceLastDone, dueOn, dueIn: dueInFrom(today, dueOn) };
  });
  const ordered = nudges
    .map((nudge, index) => ({ nudge, index }))
    .sort((a, b) => STATUS_ORDER[a.nudge.status] - STATUS_ORDER[b.nudge.status] || a.index - b.index)
    .map(({ nudge }) => nudge);
  return Object.freeze({
    version: CARE_INTERVALS_PREVIEW_VERSION,
    asOf: today,
    nudges: Object.freeze(ordered),
    dueCount: nudges.filter((nudge) => nudge.status === "DUE").length,
  });
}
