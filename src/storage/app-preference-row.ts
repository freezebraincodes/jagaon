import { z } from "zod";
import {
  supportedLocaleSchema,
  type SupportedLocale,
} from "@/domain/patient-settings/locale";
import { instantSchema, type Instant } from "@/domain/shared/time";

/**
 * Closed preference rows for the `appPreferences` Dexie table.
 *
 * Spec: storage-backup-spec.md Section 2.9. The MVP key is `language`.
 * The `value` field is a `SupportedLocale` (`en-SG | zh-SG`); `updatedAt` is a
 * validated UTC instant. This is a non-clinical rebuildable projection, not
 * health truth.
 *
 * Packet 11C Addendum C, Task C2 (hybrid spec D11, owner approval of Addendum
 * C): one more closed key, `keepWordingOnDevice`, holds the patient's "Keep
 * wording on this device" setting (a boolean; no row means off). It is the
 * only patient setting the HACKATHON_DEMO profile can persist next to the
 * language (canonical PATIENT_PREFERENCE records are not writable in this
 * profile). Following the C5 audit pattern, the new row names its own version
 * (`preferenceSchemaVersion`); the existing language row is unchanged and
 * carries none. Unlike the language projection it is carried in the backup
 * payload (version 2, `patientSettings`) and written back by a restore.
 *
 * The schemas are strict and reject unknown keys. No default locale or fallback
 * behaviour is defined here.
 */
export type LanguagePreferenceRow = {
  key: "language";
  value: SupportedLocale;
  updatedAt: Instant;
};

export const KEEP_WORDING_PREFERENCE_KEY = "keepWordingOnDevice" as const;
export const KEEP_WORDING_PREFERENCE_SCHEMA_VERSION = "app-preference.keep-wording.11c.1" as const;

/** Packet 11C Addendum C (C2): the "Keep wording on this device" setting; `value: true` keeps every wording on the device. */
export type KeepWordingPreferenceRow = {
  key: typeof KEEP_WORDING_PREFERENCE_KEY;
  preferenceSchemaVersion: typeof KEEP_WORDING_PREFERENCE_SCHEMA_VERSION;
  value: boolean;
  updatedAt: Instant;
};

export type AppPreferenceRow = LanguagePreferenceRow | KeepWordingPreferenceRow;

const languagePreferenceRowSchema = z
  .object({
    key: z.literal("language"),
    value: supportedLocaleSchema,
    updatedAt: instantSchema,
  })
  .strict();

const keepWordingPreferenceRowSchema = z
  .object({
    key: z.literal(KEEP_WORDING_PREFERENCE_KEY),
    preferenceSchemaVersion: z.literal(KEEP_WORDING_PREFERENCE_SCHEMA_VERSION),
    value: z.boolean(),
    updatedAt: instantSchema,
  })
  .strict();

export const appPreferenceRowSchema = z
  .discriminatedUnion("key", [languagePreferenceRowSchema, keepWordingPreferenceRowSchema])
  // Zod 3's object output helper widens the nested transformed Instant back
  // to string. The strict object has already validated every field here, so
  // restore the exact branded public row type at the schema boundary.
  .transform((row): AppPreferenceRow => row as AppPreferenceRow);

/**
 * Create a language preference row from an approved locale and a validated
 * instant. The values are preserved exactly — no coercion, translation,
 * trimming, or normalisation.
 */
export function createLanguagePreferenceRow(
  value: SupportedLocale,
  updatedAt: Instant,
): LanguagePreferenceRow {
  return {
    key: "language",
    value,
    updatedAt,
  };
}

/** Packet 11C Addendum C (C2): the versioned "Keep wording on this device" row (validated by the codec on write). */
export function createKeepWordingPreferenceRow(
  value: boolean,
  updatedAt: Instant,
): KeepWordingPreferenceRow {
  return {
    key: KEEP_WORDING_PREFERENCE_KEY,
    preferenceSchemaVersion: KEEP_WORDING_PREFERENCE_SCHEMA_VERSION,
    value,
    updatedAt,
  };
}
