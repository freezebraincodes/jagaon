import { z } from "zod";
import { timePointSchema } from "../shared/temporal";

// --- Section 4.6: Reading temporal meaning ---

// Both glucose and ketone readings use POINT temporal meaning and permit
// EXACT, APPROXIMATE, DATE_ONLY, or UNKNOWN occurrence time so that uncertain
// historical information can be preserved without pretending its timing is
// known.
//
// Reuses Packet 2A's timePointSchema for timestamp, local-date, timezone,
// and UTC-offset validation. Unlike body-measurement temporal, UNKNOWN is
// permitted here.
export const readingTemporalSchema = z.strictObject({
  kind: z.literal("POINT"),
  occurrence: timePointSchema,
});

export type ReadingTemporal = z.infer<typeof readingTemporalSchema>;