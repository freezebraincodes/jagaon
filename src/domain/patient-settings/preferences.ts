import { z } from "zod";
import { supportedLocaleSchema } from "./locale";
import { isValidIanaTimeZoneId } from "../shared/time";

// --- Section 3.3: PatientPreferencePayload ---

// Singapore MVP default for glucose display unit.
export const DEFAULT_GLUCOSE_DISPLAY_UNIT = "MMOL_L" as const;

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const quietHoursSchema = z
  .strictObject({
    startLocalTime: z.string().regex(hhmmRegex, "Must be a valid HH:mm time"),
    endLocalTime: z.string().regex(hhmmRegex, "Must be a valid HH:mm time"),
  })
  .refine(
    (val) => val.startLocalTime !== val.endLocalTime,
    "Quiet-hour start and end must not be equal",
  );

export type PatientPreferencePayload =
  | {
      kind: "LANGUAGE";
      locale: "en-SG" | "zh-SG";
    }
  | {
      kind: "GLUCOSE_DISPLAY_UNIT";
      unit: "MMOL_L" | "MG_DL";
    }
  | {
      kind: "ACCESSIBILITY";
      textScale: "STANDARD" | "LARGE" | "EXTRA_LARGE";
      contrast: "STANDARD" | "HIGH";
      reducedMotion: boolean;
    }
  | {
      kind: "HOME_TIME_ZONE";
      timeZoneId: string;
    }
  | {
      kind: "COMMUNICATION";
      ordinaryPromptLevel: "STANDARD" | "REDUCED" | "PAUSED";
      quietHours?: {
        startLocalTime: string;
        endLocalTime: string;
      };
    };

export const patientPreferencePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("LANGUAGE"),
    locale: supportedLocaleSchema,
  }),
  z.strictObject({
    kind: z.literal("GLUCOSE_DISPLAY_UNIT"),
    unit: z.enum(["MMOL_L", "MG_DL"]),
  }),
  z.strictObject({
    kind: z.literal("ACCESSIBILITY"),
    textScale: z.enum(["STANDARD", "LARGE", "EXTRA_LARGE"]),
    contrast: z.enum(["STANDARD", "HIGH"]),
    reducedMotion: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("HOME_TIME_ZONE"),
    timeZoneId: z.string().refine(isValidIanaTimeZoneId, "Must be a valid IANA timezone identifier"),
  }),
  z.strictObject({
    kind: z.literal("COMMUNICATION"),
    ordinaryPromptLevel: z.enum(["STANDARD", "REDUCED", "PAUSED"]),
    quietHours: quietHoursSchema.optional(),
  }),
]);