import { z } from "zod";
import { provenanceCoreSchema } from "../shared/provenance";
import { createRecordRevisionSchema } from "../shared/revision";
import { createBoundedTextSchema } from "../shared/text";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { NOTE_THEME_KEYS } from "./note-themes";

/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more): the PERSONAL_NOTE record type, `personal-note` schema version 1, in the
 * existing authoritative record store (shared `recordRevisions` / `recordHeads`; no new table).
 *
 * A record is ONE note the person chose to keep: her own words, or a summary she approved after a short feelings chat.
 * - It is created only by an explicit save (CREATE); it is never edited in this version, and it is removed by the existing patient
 *   permanent deletion (revisions removed, tombstone kept; no note text remains).
 * - Feeling cues are short lowercase keys ("tired", "worried"); themes are the closed descriptive list in `note-themes.ts` (never causes
 *   or diagnoses).
 * - `turns` keeps at most seven lines of the chat that led to the note; every JagaOn line names where it came from (an AI line that
 *   passed validation, or the reviewed sentence bank), and every patient line is the patient's.
 * - `aiUsed` is true only when an AI service helped; then `promptVersion` names the prompt and the provenance is AI_ASSISTED.
 * - The note is ATEMPORAL (it is not a health event at a time); its creation instant is the revision's `recordedAt`, which lists and
 *   the "this week" theme counts use.
 */
export const PERSONAL_NOTE_RECORD_TYPE = "PERSONAL_NOTE" as const;
export const PERSONAL_NOTE_SCHEMA_VERSION = 1;
export const PERSONAL_NOTE_TEXT_MAX_CODE_POINTS = 1000;
export const PERSONAL_NOTE_MAX_FEELING_CUES = 12;
export const PERSONAL_NOTE_FEELING_CUE_MAX_LENGTH = 32;
export const PERSONAL_NOTE_MAX_TURNS = 7;
export const PERSONAL_NOTE_PROMPT_VERSION_MAX_LENGTH = 64;
export const PERSONAL_NOTE_REVISION_ACTIONS = Object.freeze(["CREATE"] as const);

export const PERSONAL_NOTE_LANGUAGES = Object.freeze(["en-SG", "zh-SG", "und"] as const);
export const personalNoteLanguageSchema = z.enum(PERSONAL_NOTE_LANGUAGES);
export type PersonalNoteLanguage = z.infer<typeof personalNoteLanguageSchema>;

export const PERSONAL_NOTE_TURN_ROLES = Object.freeze(["PATIENT", "JAGAON_QUESTION", "JAGAON_KIND_SENTENCE"] as const);
export const PERSONAL_NOTE_TURN_SOURCES = Object.freeze(["PATIENT", "AI_VALIDATED", "REVIEWED_BANK"] as const);

const noteTextSchema = createBoundedTextSchema(1, PERSONAL_NOTE_TEXT_MAX_CODE_POINTS);

/** A plain lowercase key: letters, optionally joined by single hyphens or underscores ("tired", "worn-out"). */
const FEELING_CUE = /^[a-z]+(?:[-_][a-z]+)*$/;
export const feelingCueSchema = z.string().min(1).max(PERSONAL_NOTE_FEELING_CUE_MAX_LENGTH).regex(FEELING_CUE);

export const personalNoteTurnSchema = z
  .strictObject({
    role: z.enum(PERSONAL_NOTE_TURN_ROLES),
    text: noteTextSchema,
    source: z.enum(PERSONAL_NOTE_TURN_SOURCES),
  })
  .refine((turn) => (turn.role === "PATIENT") === (turn.source === "PATIENT"), "TURN_SOURCE_DISAGREES_WITH_ROLE");
export type PersonalNoteTurn = z.infer<typeof personalNoteTurnSchema>;

export const careQuestionRevisionRefSchema = createTypedRevisionRefSchema(z.literal("CARE_QUESTION"));

export const personalNotePayloadSchema = z
  .strictObject({
    text: noteTextSchema,
    language: personalNoteLanguageSchema,
    feelingCues: z.array(feelingCueSchema).max(PERSONAL_NOTE_MAX_FEELING_CUES),
    turns: z.array(personalNoteTurnSchema).max(PERSONAL_NOTE_MAX_TURNS),
    themes: z.array(z.enum(NOTE_THEME_KEYS)).max(NOTE_THEME_KEYS.length),
    aiUsed: z.boolean(),
    promptVersion: z.string().min(1).max(PERSONAL_NOTE_PROMPT_VERSION_MAX_LENGTH).nullable(),
    careQuestionRef: careQuestionRevisionRefSchema.nullable(),
  })
  .superRefine((payload, context) => {
    if (new Set(payload.themes).size !== payload.themes.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "THEMES_NOT_UNIQUE", path: ["themes"] });
    if (payload.aiUsed && payload.promptVersion === null) context.addIssue({ code: z.ZodIssueCode.custom, message: "PROMPT_VERSION_REQUIRED_WHEN_AI_USED", path: ["promptVersion"] });
    if (!payload.aiUsed && payload.turns.some((turn) => turn.source === "AI_VALIDATED")) context.addIssue({ code: z.ZodIssueCode.custom, message: "AI_TURN_WITHOUT_AI_USED", path: ["turns"] });
  });
export type PersonalNotePayload = z.infer<typeof personalNotePayloadSchema>;

/** Only the patient saves a note, through an explicit save; an AI service may have helped (then AI_ASSISTED), never initiated. */
const patientEntryProvenanceSchema = provenanceCoreSchema.refine(
  (provenance) => provenance.sourceKind === "PATIENT_ENTRY" && provenance.captureMethod === "FORM" && provenance.initiator === "PATIENT",
  "PERSONAL_NOTE_REQUIRES_PATIENT_ENTRY",
);

export const personalNoteRevisionSchema = createRecordRevisionSchema(
  z.literal(PERSONAL_NOTE_RECORD_TYPE),
  personalNotePayloadSchema,
  z.strictObject({ kind: z.literal("ATEMPORAL") }),
  patientEntryProvenanceSchema,
).superRefine((revision, context) => {
  if (revision.schemaVersion !== PERSONAL_NOTE_SCHEMA_VERSION) context.addIssue({ code: z.ZodIssueCode.custom, message: "SCHEMA_VERSION" });
  if (!(PERSONAL_NOTE_REVISION_ACTIONS as readonly string[]).includes(revision.action)) context.addIssue({ code: z.ZodIssueCode.custom, message: "ACTION_NOT_ALLOWED" });
  if (revision.revisionNumber !== 1 || revision.previousRevisionId !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: "CHAIN_DISAGREES_WITH_ACTION" });
  if ((revision.provenance.assistance === "AI_ASSISTED") !== revision.payload.aiUsed) context.addIssue({ code: z.ZodIssueCode.custom, message: "ASSISTANCE_DISAGREES_WITH_AI_USED" });
});

export type PersonalNoteRevision = z.infer<typeof personalNoteRevisionSchema>;
