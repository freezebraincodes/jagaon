import { z, type ZodType, type ZodTypeDef } from "zod";
import { instantSchema, type Instant } from "@/domain/shared/time";
import { createStorageRowCodec } from "./storage-row-codec";

/**
 * The one storage-metadata variant owned by Packet 4F3.
 *
 * Zero represents a fresh dataset. Positive values represent the last
 * sequence allocated atomically with committed domain events.
 */
export type EventSequenceHighWaterMarkRow = {
  key: "EVENT_SEQUENCE_HIGH_WATER_MARK";
  lastAllocatedSequence: number;
  updatedAt: Instant;
};

export const eventSequenceHighWaterMarkRowSchema: ZodType<
  EventSequenceHighWaterMarkRow,
  ZodTypeDef,
  unknown
> = z
  .object({
    key: z.literal("EVENT_SEQUENCE_HIGH_WATER_MARK"),
    lastAllocatedSequence: z.number().int().nonnegative().safe(),
    updatedAt: instantSchema,
  })
  .strict()
  .transform((row): EventSequenceHighWaterMarkRow =>
    row as EventSequenceHighWaterMarkRow,
  );

/** Internal table-specific codec. Deliberately not re-exported by the barrel. */
export const eventSequenceHighWaterMarkRowCodec = createStorageRowCodec(
  "storageMetadata",
  eventSequenceHighWaterMarkRowSchema,
);
