import { z } from "zod";
import { commandIdSchema, correlationIdSchema, domainEventIdSchema } from "@/application/contracts/command-event-identifiers";
import { activityEventPayloadSchema } from "@/domain/health-records/activity-event";
import { glucoseReadingPayloadSchema } from "@/domain/health-records/glucose-reading";
import { intakeEventPayloadSchema } from "@/domain/health-records/intake-event";
import { medicationEventPayloadSchema } from "@/domain/health-records/medication-event";
import { auditEventIdSchema, instantSchema, recordIdSchema, revisionIdSchema, transactionIdSchema } from "@/domain/shared";
import { createStorageRowCodec, StorageRowValidationError, type StorageRowCodec } from "@/storage/storage-row-codec";
import {
  activityEventRevisionCodec,
  glucoseReadingRevisionCodec,
  intakeEventRevisionCodec,
  medicationEventRevisionCodec,
} from "./journal-row-codecs";

/**
 * Packet 10A closed journal stored rows (storage-backup-spec Sections 2.3–2.4).
 *
 * The journal command service's write path is unchanged. These exact schemas
 * close the journal's audit and event rows for the profile registry so a
 * stored journal row is never accepted through a permissive reader.
 *
 * Packet 6 source events copy the revision payload. After a confirmed
 * permanent deletion, that prohibited copy is replaced by the closed
 * `PATIENT_CONTENT_DELETED` marker (storage-backup-spec 6.5 step 5 and 6.6;
 * event-contracts-spec 12.4); event identity, sequence and change refs stay.
 */

export const JOURNAL_STORED_RECORD_TYPES = Object.freeze(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT"] as const);
type JournalRecordType = (typeof JOURNAL_STORED_RECORD_TYPES)[number];

const EVENT_TARGETS: Readonly<Record<string, { recordType: JournalRecordType; action: "CREATE" | "CORRECT" }>> = Object.freeze({
  GLUCOSE_READING_RECORDED: { recordType: "GLUCOSE_READING", action: "CREATE" },
  GLUCOSE_READING_CORRECTED: { recordType: "GLUCOSE_READING", action: "CORRECT" },
  MEDICATION_EVENT_RECORDED: { recordType: "MEDICATION_EVENT", action: "CREATE" },
  MEDICATION_EVENT_CORRECTED: { recordType: "MEDICATION_EVENT", action: "CORRECT" },
  INTAKE_EVENT_RECORDED: { recordType: "INTAKE_EVENT", action: "CREATE" },
  ACTIVITY_EVENT_RECORDED: { recordType: "ACTIVITY_EVENT", action: "CREATE" },
});
export const JOURNAL_EVENT_NAMES = Object.freeze(Object.keys(EVENT_TARGETS) as [string, ...string[]]);

const PAYLOAD_BY_TYPE: Readonly<Record<JournalRecordType, z.ZodTypeAny>> = Object.freeze({
  GLUCOSE_READING: glucoseReadingPayloadSchema,
  MEDICATION_EVENT: medicationEventPayloadSchema,
  INTAKE_EVENT: intakeEventPayloadSchema,
  ACTIVITY_EVENT: activityEventPayloadSchema,
});

/** The closed marker that replaces a deleted record's copied event payload. */
export const JOURNAL_DELETED_EVENT_PAYLOAD = Object.freeze({ reasonCode: "PATIENT_CONTENT_DELETED" } as const);
const deletedPayloadSchema = z.strictObject({ reasonCode: z.literal("PATIENT_CONTENT_DELETED") });

export const JOURNAL_AUDIT_REASONS = Object.freeze(["PATIENT_LOGGED", "PATIENT_CORRECTED"] as const);

const journalAuditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.enum(JOURNAL_STORED_RECORD_TYPES),
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema,
    action: z.enum(["CREATE", "CORRECT"]),
    initiator: z.literal("PATIENT"),
    assistance: z.literal("NONE"),
    occurredAt: instantSchema,
    reasonCode: z.enum(JOURNAL_AUDIT_REASONS),
  })
  .refine((row) => (row.action === "CREATE") === (row.previousRevisionId === null), "CREATE_HAS_NO_PREVIOUS_REVISION");

const journalEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.enum(JOURNAL_EVENT_NAMES),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: z.strictObject({
      kind: z.literal("REVISION_CREATED"),
      recordType: z.enum(JOURNAL_STORED_RECORD_TYPES),
      recordId: recordIdSchema,
      action: z.enum(["CREATE", "CORRECT"]),
      previousRevisionId: revisionIdSchema.nullable(),
      resultingRevisionId: revisionIdSchema,
      resultingRevisionNumber: z.number().int().positive().safe(),
    }),
    payload: z.unknown(),
  })
  .superRefine((row, ctx) => {
    const target = EVENT_TARGETS[row.eventName];
    if (!target || target.recordType !== row.change.recordType || target.action !== row.change.action) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "EVENT_NAME_DISAGREES_WITH_CHANGE" });
      return;
    }
    if (!PAYLOAD_BY_TYPE[target.recordType].safeParse(row.payload).success && !deletedPayloadSchema.safeParse(row.payload).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNKNOWN_JOURNAL_EVENT_PAYLOAD" });
    }
  });

const REVISION_CODEC_BY_TYPE: Readonly<Record<JournalRecordType, StorageRowCodec<unknown>>> = Object.freeze({
  GLUCOSE_READING: glucoseReadingRevisionCodec,
  MEDICATION_EVENT: medicationEventRevisionCodec,
  INTAKE_EVENT: intakeEventRevisionCodec,
  ACTIVITY_EVENT: activityEventRevisionCodec,
});

const journalRevisionRowCodec: StorageRowCodec<unknown> = Object.freeze({
  validateForWrite(value: unknown) {
    const codec = REVISION_CODEC_BY_TYPE[(value as { recordType?: JournalRecordType } | null)?.recordType as JournalRecordType];
    if (!codec) throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "recordRevisions", "WRITE");
    return codec.validateForWrite(value);
  },
  validateAfterRead(value: unknown) {
    const codec = REVISION_CODEC_BY_TYPE[(value as { recordType?: JournalRecordType } | null)?.recordType as JournalRecordType];
    if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return codec.validateAfterRead(value);
  },
});

export const JOURNAL_STORED_ROW_CODECS = Object.freeze({
  revision: journalRevisionRowCodec,
  audit: createStorageRowCodec("auditEvents", journalAuditRowSchema),
  event: createStorageRowCodec("domainEvents", journalEventRowSchema),
});

/** True for a journal source event name whose payload copies the revision payload. */
export function isJournalSourceEventName(eventName: string): boolean {
  return Object.prototype.hasOwnProperty.call(EVENT_TARGETS, eventName);
}
