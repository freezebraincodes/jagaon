import type { ImplementedReleaseProfile } from "@/config/release-profile";
import { instantSchema, type Instant } from "@/domain/shared/time";
import type { JagaOnDatabase } from "./database";
import {
  eventSequenceHighWaterMarkRowCodec,
  type EventSequenceHighWaterMarkRow,
} from "./event-sequence-metadata";
import { JAGAON_TABLE_NAMES } from "./table-catalogue";

export const DEMO_STORAGE_RESET_CONFIRMATION =
  "RESET_SYNTHETIC_DEMO_DATABASE" as const;

export type SyntheticDemoStorageResetRequest = {
  releaseProfile: ImplementedReleaseProfile;
  confirmation: typeof DEMO_STORAGE_RESET_CONFIRMATION;
  resetAt: Instant;
};

/**
 * Destructively reset the synthetic hackathon database as one transaction.
 *
 * This operation is intentionally impossible to invoke for a patient release:
 * both the implemented release profile and an exact explicit confirmation
 * literal are required. A successful reset clears the closed 16-table
 * catalogue and initializes only the event-sequence high-water row at zero.
 */
export async function resetSyntheticDemoStorage(
  database: JagaOnDatabase,
  request: SyntheticDemoStorageResetRequest,
): Promise<void> {
  if (request.releaseProfile !== "HACKATHON_DEMO") {
    throw new Error("DEMO_STORAGE_RESET_FORBIDDEN");
  }
  if (request.confirmation !== DEMO_STORAGE_RESET_CONFIRMATION) {
    throw new Error("DEMO_STORAGE_RESET_CONFIRMATION_REQUIRED");
  }

  const resetAt = instantSchema.parse(request.resetAt);
  const tables = JAGAON_TABLE_NAMES.map((name) => database.table(name));
  const metadata = database.table<EventSequenceHighWaterMarkRow, string>(
    "storageMetadata",
  );
  const initialSequence = eventSequenceHighWaterMarkRowCodec.validateForWrite({
    key: "EVENT_SEQUENCE_HIGH_WATER_MARK",
    lastAllocatedSequence: 0,
    updatedAt: resetAt,
  });

  await database.transaction("rw", tables, async () => {
    for (const table of tables) await table.clear();
    await metadata.add(initialSequence);
  });
}
