import type { Table } from "dexie";
import { instantSchema, type Instant } from "@/domain/shared/time";
import {
  createKeepWordingPreferenceRow,
  KEEP_WORDING_PREFERENCE_KEY,
  type AppPreferenceRow,
} from "./app-preference-row";
import type { JagaOnDatabase } from "./database";
import { implementedStorageRowCodecs } from "./implemented-row-codecs";

/**
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting, persisted as the
 * `keepWordingOnDevice` row of `appPreferences` next to the language row.
 *
 * - `read()`: no row (every dataset before C2, a new dataset, an old backup restored where the setting was not on) is off (spec D11:
 *   "default off for the demo"; C2 fix round 1, I-2: a restore never turns it off). A
 *   stored row that does not validate reads as ON (fail closed: wording stays on the device and nothing is sent); a read never rewrites
 *   or deletes it. (At launch the integrity gate already refuses a dataset with a malformed row; this is defence in depth.)
 * - `persist(keepOnDevice, updatedAt)`: writes the one versioned row through the closed codec, so a non-boolean is refused before any
 *   write.
 *
 * The row carries no health truth, provider field or identifier. Backup and restore carry its value through the payload's
 * `patientSettings` (backup payload version 2; a restore writes backup || device); delete-all removes it with the database.
 */
export type KeepWordingPreferenceRepository = Readonly<{
  read(): Promise<boolean>;
  persist(keepOnDevice: boolean, updatedAt: Instant): Promise<void>;
}>;

export function createKeepWordingPreferenceRepository(database: JagaOnDatabase): KeepWordingPreferenceRepository {
  const preferences = database.table<AppPreferenceRow, string>("appPreferences") as Table<AppPreferenceRow, string>;
  return Object.freeze({
    async read(): Promise<boolean> {
      const raw = await preferences.get(KEEP_WORDING_PREFERENCE_KEY);
      if (raw === undefined) return false;
      try {
        const row = implementedStorageRowCodecs.appPreferences.validateAfterRead(raw);
        return row.key === KEEP_WORDING_PREFERENCE_KEY ? row.value : true;
      } catch {
        return true;
      }
    },
    async persist(keepOnDevice: boolean, updatedAt: Instant): Promise<void> {
      const row = implementedStorageRowCodecs.appPreferences.validateForWrite(createKeepWordingPreferenceRow(keepOnDevice, instantSchema.parse(updatedAt)));
      await preferences.put(row);
    },
  });
}
