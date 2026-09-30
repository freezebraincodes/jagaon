import { z } from "zod";
import {
  supportedLocaleSchema,
  type SupportedLocale,
} from "@/domain/patient-settings/locale";
import { instantSchema, type Instant } from "@/domain/shared/time";

/**
 * Closed bootstrap-language preference row for the `appPreferences` Dexie
 * table.
 *
 * Spec: storage-backup-spec.md Section 2.9. The only MVP key is `language`.
 * The `value` field is a `SupportedLocale` (`en-SG | zh-SG`); `updatedAt` is a
 * validated UTC instant. This is a non-clinical rebuildable projection, not
 * health truth.
 *
 * The schema is strict and rejects unknown keys. No default locale or fallback
 * behaviour is defined here.
 */
export type AppPreferenceRow = {
  key: "language";
  value: SupportedLocale;
  updatedAt: Instant;
};

export const appPreferenceRowSchema = z
  .object({
    key: z.literal("language"),
    value: supportedLocaleSchema,
    updatedAt: instantSchema,
  })
  .strict()
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
): AppPreferenceRow {
  return {
    key: "language",
    value,
    updatedAt,
  };
}
