import { z } from "zod";
import { temporalMeaningSchema } from "../shared/temporal";

// --- Section 5.3 / 5.5 / 5.7: Observation temporal contracts ---

// Reuses Packet 2A's temporalMeaningSchema so that all temporal validation —
// timestamp, local-date, timezone, uncertainty, UTC-offset, interval-end
// structure, and the invariant that a known interval end must be later
// than its known start — is not duplicated. No entry or creation timestamp
// substitutes for an unknown occurrence.

// --- Intake temporal (Section 5.3) ---

// POINT only, permitting EXACT, APPROXIMATE, DATE_ONLY, or UNKNOWN occurrence.
export const intakeTemporalSchema = temporalMeaningSchema.refine(
  (val) => val.kind === "POINT",
  "Intake temporal must be POINT",
);

export type IntakeTemporal = z.infer<typeof intakeTemporalSchema>;

// --- Symptom temporal (Section 5.5) ---

// POINT or INTERVAL, never ATEMPORAL. EXPLICIT_NONE and UNSURE still carry
// the time boundary. For intervals, OPEN means ongoing; UNKNOWN means the
// end is not known — neither is conflated.
export const symptomTemporalSchema = temporalMeaningSchema.refine(
  (val) => val.kind === "POINT" || val.kind === "INTERVAL",
  "Symptom temporal must be POINT or INTERVAL",
);

export type SymptomTemporal = z.infer<typeof symptomTemporalSchema>;

// --- Activity temporal (Section 5.7) ---

// POINT or INTERVAL, never ATEMPORAL.
export const activityTemporalSchema = temporalMeaningSchema.refine(
  (val) => val.kind === "POINT" || val.kind === "INTERVAL",
  "Activity temporal must be POINT or INTERVAL",
);

export type ActivityTemporal = z.infer<typeof activityTemporalSchema>;