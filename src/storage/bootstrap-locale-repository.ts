import type { Table } from "dexie";
import {
  supportedLocaleSchema,
  type SupportedLocale,
} from "@/domain/patient-settings/locale";
import { instantSchema, type Instant } from "@/domain/shared/time";
import {
  createLanguagePreferenceRow,
  type AppPreferenceRow,
} from "./app-preference-row";
import type { JagaOnDatabase } from "./database";
import { implementedStorageRowCodecs } from "./implemented-row-codecs";

export type BootstrapLocaleRepository = {
  /**
   * Resolve the shell locale without creating health truth.
   *
   * A canonical patient preference, when present, is authoritative and
   * repairs the rebuildable bootstrap projection. Before onboarding, a valid
   * projection may be reused. Missing or malformed projections resolve only
   * to the neutral `en-SG` shell fallback and are never persisted as a
   * canonical record.
   */
  resolve(
    canonicalLocale: SupportedLocale | null,
    updatedAt: Instant,
  ): Promise<SupportedLocale>;
};

export function createBootstrapLocaleRepository(
  database: JagaOnDatabase,
): BootstrapLocaleRepository {
  const preferences = database.table<AppPreferenceRow, string>(
    "appPreferences",
  ) as Table<AppPreferenceRow, string>;

  return Object.freeze({
    async resolve(
      canonicalLocale: SupportedLocale | null,
      updatedAt: Instant,
    ): Promise<SupportedLocale> {
      const parsedAt = instantSchema.parse(updatedAt);
      const parsedCanonical =
        canonicalLocale === null
          ? null
          : supportedLocaleSchema.parse(canonicalLocale);

      return database.transaction("rw", preferences, async () => {
        if (parsedCanonical !== null) {
          const row =
            implementedStorageRowCodecs.appPreferences.validateForWrite(
              createLanguagePreferenceRow(parsedCanonical, parsedAt),
            );
          await preferences.put(row);
          return parsedCanonical;
        }

        const raw = await preferences.get("language");
        if (raw === undefined) return "en-SG";

        try {
          return implementedStorageRowCodecs.appPreferences.validateAfterRead(
            raw,
          ).value;
        } catch {
          // This row is explicitly rebuildable and contains no health truth.
          // Delete corruption rather than leaking an unsupported locale into
          // the neutral shell; the fallback remains in memory only.
          await preferences.delete("language");
          return "en-SG";
        }
      });
    },
  });
}
