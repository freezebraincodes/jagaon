/**
 * The prepared demo profile's recorded history: a static, synthetic data set (owner instruction, 2026-10-12). Every value and time is
 * fixed here; nothing is generated at random. `daysAgo` counts local Singapore days back from the day the profile is prepared (1 is
 * yesterday), so the newest entry is always yesterday and nothing is dated today or later. `time` is the local wall-clock time (HH:MM).
 *
 * Shape (42 days): before-breakfast readings on most days (a few days not recorded), before-dinner readings on some days (fewer in the
 * last two weeks), routine meals in the last three weeks, morning walks from the last two and a half weeks, and one reading whose time
 * was later corrected (entered as 07:37, corrected to 07:07). The before-breakfast values move from about 7.0–8.2 mmol/L in the earlier
 * weeks to about 5.7–6.6 in the last two weeks (the History comparison shows them lower). Owner request 2026-10-16 (a second
 * comparison for the demo): the before-dinner values move from about 7.4–8.4 in the earlier weeks to about 8.8–9.4 in the last two
 * weeks, with six recent readings on six days over two weeks (all inside the last 13 days, so the comparison holds at any time of
 * day), so History also shows them higher. Three recent before-breakfast readings were dropped; their recent median stays 6.1 whether
 * or not the day-14 reading falls inside the window (the window starts at the clock time 14 days ago).
 * The 13 days before today hold 12 glucose readings (the 14 days before today still hold 13, as before): a visit summary of the 14-day period with the appointment and one question is 14
 * facts (15 with two questions), well under the 32-fact limit of a care-summary request and within its English remote wording budget,
 * which the planner measures separately (about 16 readings with the appointment and one question; about 13 with two). All values are
 * synthetic, plausible and carry no clinical meaning.
 */

export type PreparedDemoHistoryRow =
  | Readonly<{
      daysAgo: number;
      time: string;
      kind: "GLUCOSE";
      slot: "BEFORE_BREAKFAST" | "BEFORE_DINNER";
      value: string;
      /** The local time (same day) the patient later corrected the entry to. */
      correctedTime?: string;
    }>
  | Readonly<{ daysAgo: number; time: string; kind: "MEAL"; slot: "BREAKFAST" | "LUNCH"; label: string }>
  | Readonly<{ daysAgo: number; time: string; kind: "ACTIVITY"; label: string; durationMinutes: number }>;

/** Oldest first. */
export const PREPARED_DEMO_HISTORY_ROWS: readonly PreparedDemoHistoryRow[] = Object.freeze([
  { daysAgo: 42, time: "07:31", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.9" },
  { daysAgo: 41, time: "07:18", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "8.1" },
  { daysAgo: 41, time: "18:42", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.8" },
  { daysAgo: 40, time: "07:44", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.6" },
  { daysAgo: 39, time: "07:06", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "8.2" },
  { daysAgo: 39, time: "18:15", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "8.3" },
  { daysAgo: 38, time: "07:37", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.8" },
  { daysAgo: 36, time: "07:52", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.7" },
  { daysAgo: 36, time: "19:05", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.5" },
  { daysAgo: 35, time: "07:12", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "8.0" },
  { daysAgo: 34, time: "07:26", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.5" },
  { daysAgo: 34, time: "18:27", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "8.0" },
  { daysAgo: 33, time: "07:03", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.9" },
  { daysAgo: 32, time: "07:41", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.4" },
  { daysAgo: 32, time: "18:51", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.6" },
  { daysAgo: 31, time: "07:15", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.8" },
  { daysAgo: 29, time: "07:48", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.6" },
  { daysAgo: 29, time: "18:09", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "8.4" },
  { daysAgo: 28, time: "07:09", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.3" },
  { daysAgo: 27, time: "07:33", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.7" },
  { daysAgo: 27, time: "19:18", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.7" },
  { daysAgo: 26, time: "07:21", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.2" },
  { daysAgo: 25, time: "06:58", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.5" },
  { daysAgo: 25, time: "18:36", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.9" },
  { daysAgo: 23, time: "07:39", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.4" },
  { daysAgo: 22, time: "07:14", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.1" },
  { daysAgo: 22, time: "18:23", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.4" },
  { daysAgo: 21, time: "07:46", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.6" },
  { daysAgo: 20, time: "07:02", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.0" },
  { daysAgo: 20, time: "07:22", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 20, time: "19:02", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "8.1" },
  { daysAgo: 19, time: "12:35", kind: "MEAL", slot: "LUNCH", label: "Chicken rice" },
  { daysAgo: 18, time: "07:29", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.3" },
  { daysAgo: 18, time: "07:49", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 17, time: "07:17", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.2" },
  { daysAgo: 17, time: "18:47", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.6" },
  { daysAgo: 16, time: "07:50", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.0" },
  { daysAgo: 16, time: "08:24", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 22 },
  { daysAgo: 16, time: "12:52", kind: "MEAL", slot: "LUNCH", label: "Chicken rice" },
  { daysAgo: 15, time: "07:08", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "7.4" },
  { daysAgo: 15, time: "07:31", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 15, time: "18:12", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "7.8" },
  { daysAgo: 14, time: "07:35", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "6.6" },
  { daysAgo: 13, time: "07:28", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 13, time: "08:16", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 30 },
  { daysAgo: 13, time: "18:55", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "8.9" },
  { daysAgo: 12, time: "07:43", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "6.3" },
  { daysAgo: 12, time: "12:18", kind: "MEAL", slot: "LUNCH", label: "Chicken rice" },
  { daysAgo: 12, time: "18:31", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "9.2" },
  { daysAgo: 11, time: "08:31", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 25 },
  { daysAgo: 10, time: "07:24", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "6.4" },
  { daysAgo: 10, time: "07:41", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 10, time: "18:40", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "9.4" },
  { daysAgo: 9, time: "07:05", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "6.1" },
  { daysAgo: 9, time: "08:22", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 28 },
  { daysAgo: 9, time: "13:04", kind: "MEAL", slot: "LUNCH", label: "Chicken rice" },
  { daysAgo: 8, time: "07:55", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 7, time: "08:09", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 32 },
  { daysAgo: 7, time: "18:05", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "9.0" },
  { daysAgo: 6, time: "08:06", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 6, time: "08:37", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 24 },
  { daysAgo: 5, time: "12:41", kind: "MEAL", slot: "LUNCH", label: "Chicken rice" },
  { daysAgo: 5, time: "18:22", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "8.8" },
  { daysAgo: 4, time: "08:28", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 35 },
  { daysAgo: 3, time: "07:32", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "6.1" },
  { daysAgo: 3, time: "07:50", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 3, time: "18:47", kind: "GLUCOSE", slot: "BEFORE_DINNER", value: "9.3" },
  { daysAgo: 2, time: "07:37", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "5.7", correctedTime: "07:07" },
  { daysAgo: 2, time: "08:14", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 30 },
  { daysAgo: 2, time: "12:26", kind: "MEAL", slot: "LUNCH", label: "Chicken rice" },
  { daysAgo: 1, time: "07:27", kind: "GLUCOSE", slot: "BEFORE_BREAKFAST", value: "5.9" },
  { daysAgo: 1, time: "07:44", kind: "MEAL", slot: "BREAKFAST", label: "Kaya toast" },
  { daysAgo: 1, time: "08:19", kind: "ACTIVITY", label: "Morning walk", durationMinutes: 27 },
] as const satisfies readonly PreparedDemoHistoryRow[]);
