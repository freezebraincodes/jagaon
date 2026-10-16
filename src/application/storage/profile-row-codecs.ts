import { CARE_ORGANISATION_STORED_ROW_CODECS } from "@/application/care-organisation/care-organisation-persistence";
import { CARE_PLAN_STORED_ROW_CODECS } from "@/application/care-plan/care-plan-persistence";
import { CARE_PREPARATION_STORED_ROW_CODECS } from "@/application/care-preparation/care-preparation-persistence";
import { PERMANENT_DELETION_STORED_ROW_CODECS } from "@/application/deletion/deletion-rows";
import { INQUIRY_STORED_ROW_CODECS } from "@/application/inquiry/inquiry-persistence";
import { INTELLIGENCE_STORED_ROW_CODECS } from "@/application/intelligence/intelligence-persistence";
import { JOURNAL_STORED_ROW_CODECS } from "@/application/journal/journal-stored-rows";
import { PERSONAL_NOTE_STORED_ROW_CODECS } from "@/application/notes/personal-note-persistence";
import { TERMINOLOGY_STORED_ROW_CODECS } from "@/application/terminology/terminology-persistence";
import { createClosedRowCodecRegistry, createUnionRowCodec, type ClosedRowCodecRegistry } from "@/storage/closed-row-codecs";
import type { StorageRowCodec } from "@/storage/storage-row-codec";

/**
 * The complete closed row-codec registry for the compiled `HACKATHON_DEMO`
 * profile (Packet 10 freeze Section 4). Each multi-owner table accepts a row
 * only when one enabled owner's exact write schema accepts it. No Packet 5A
 * Safety owner is a member.
 */

const OWNERS = [
  JOURNAL_STORED_ROW_CODECS,
  CARE_PLAN_STORED_ROW_CODECS,
  CARE_ORGANISATION_STORED_ROW_CODECS,
  INQUIRY_STORED_ROW_CODECS,
  INTELLIGENCE_STORED_ROW_CODECS,
  CARE_PREPARATION_STORED_ROW_CODECS,
  // Packet 13 (P13S): the patient-terminology owner rows (revision, audit, event).
  TERMINOLOGY_STORED_ROW_CODECS,
  // Owner decision 2026-10-14 (My notes): the personal-note owner rows (revision, audit, event).
  PERSONAL_NOTE_STORED_ROW_CODECS,
] as const;

const codecs = <K extends "revision" | "audit" | "event">(key: K) => OWNERS.map((owner) => owner[key] as StorageRowCodec<unknown>);

export const HACKATHON_CLOSED_ROW_CODECS: ClosedRowCodecRegistry = createClosedRowCodecRegistry({
  recordRevisions: createUnionRowCodec("recordRevisions", codecs("revision")),
  auditEvents: createUnionRowCodec("auditEvents", [...codecs("audit"), PERMANENT_DELETION_STORED_ROW_CODECS.audit]),
  domainEvents: createUnionRowCodec("domainEvents", [...codecs("event"), PERMANENT_DELETION_STORED_ROW_CODECS.event]),
});
