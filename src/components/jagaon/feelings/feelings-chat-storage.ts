import type { CareOrganisationCommandPort, CareOrganisationQueryPort } from "@/application/care-organisation/care-organisation-contracts";
import type { PersonalNoteCommandService } from "@/application/notes/personal-note-service";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { FeelingsChatNote } from "./FeelingsChatDialog";

export type FeelingsChatCareQuestionRef = TypedRevisionRef<"CARE_QUESTION">;

export type FeelingsChatStoragePorts = Readonly<{
  /** `runtime.notes.commands`. */
  notes: Pick<PersonalNoteCommandService, "createPersonalNote">;
  /** `runtime.careOrganisation`: the visit preparation (for the next appointment) and the existing care-question command. */
  careOrganisation: Readonly<{ commands: Pick<CareOrganisationCommandPort, "createCareQuestion">; query: Pick<CareOrganisationQueryPort, "loadVisitPreparation"> }>;
}>;

export type FeelingsChatStorage = Readonly<{
  /** Adds her doctor question; resolves the new care question's exact revision, or null when it was not added. */
  addDoctorQuestion(text: string): Promise<FeelingsChatCareQuestionRef | null>;
  /** Saves the chat as one personal note linked to `careQuestionRef` (null when no question was added in this chat); true when saved. */
  saveNote(note: FeelingsChatNote, careQuestionRef: FeelingsChatCareQuestionRef | null): Promise<boolean>;
}>;

/**
 * Tell JagaOn understands more (design §3.1 step 7, §3.9): the two saves at the end of a feelings chat, over the EXISTING commands.
 * - The doctor question → `createCareQuestion`, exactly as "Prepare for my appointment" adds one by hand: her text with language
 *   "und", patient-authored, linked to the appointment that screen shows (the visit preparation's appointment) when there is one. A
 *   new care question starts unticked there (the selection is the screen's, never stored).
 * - The note → `createPersonalNote`: the dialog's note (summary, turns, themes, aiUsed, promptVersion) with language en-SG (the chat is
 *   English only) and `careQuestionRef`, the exact revision returned when she added the doctor question in this chat.
 * Never throws: any failure resolves null or false, and the dialog says it was not saved.
 */
export function createFeelingsChatStorage(ports: FeelingsChatStoragePorts): FeelingsChatStorage {
  return Object.freeze({
    async addDoctorQuestion(text: string): Promise<FeelingsChatCareQuestionRef | null> {
      try {
        // No readable appointment: the question is still added, unlinked (as on the visit-preparation screen without one).
        const appointment = await ports.careOrganisation.query.loadVisitPreparation().then(
          (view) => (view.status === "READY" ? view.appointment : null),
          () => null,
        );
        const result = await ports.careOrganisation.commands.createCareQuestion({
          questionText: { text, language: "und" },
          ...(appointment ? { relatedAppointment: { recordType: "APPOINTMENT" as const, recordId: appointment.recordId, revisionId: appointment.revisionId } } : {}),
        });
        return result.kind === "COMMITTED" ? Object.freeze({ recordType: "CARE_QUESTION" as const, recordId: result.recordId, revisionId: result.revisionId }) : null;
      } catch {
        return null;
      }
    },
    async saveNote(note: FeelingsChatNote, careQuestionRef: FeelingsChatCareQuestionRef | null): Promise<boolean> {
      try {
        const result = await ports.notes.createPersonalNote({
          payload: {
            text: note.text,
            language: "en-SG",
            feelingCues: [...note.feelingCues],
            turns: note.turns.map((turn) => ({ role: turn.role, text: turn.text, source: turn.source })),
            themes: [...note.themes],
            aiUsed: note.aiUsed,
            promptVersion: note.promptVersion,
            careQuestionRef: careQuestionRef ? { recordType: "CARE_QUESTION", recordId: careQuestionRef.recordId, revisionId: careQuestionRef.revisionId } : null,
          },
        });
        return result.kind === "COMMITTED";
      } catch {
        return false;
      }
    },
  });
}
