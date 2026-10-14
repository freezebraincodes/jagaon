// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { VisitPreparationView } from "@/application/care-organisation/care-organisation-contracts";
import { createFeelingsChatStorage, type FeelingsChatStoragePorts } from "./feelings-chat-storage";
import type { FeelingsChatNote } from "./FeelingsChatDialog";

/** Tell JagaOn understands more (design §3.1 step 7): the chat's two saves over the existing commands, with spies. Synthetic data only. */

const APPOINTMENT = { recordId: "rec-appointment-1", revisionId: "rev-appointment-1" };
const NOTE: FeelingsChatNote = {
  text: "Feeling tired; sleeping about 4 hours.",
  feelingCues: ["tired"],
  turns: [
    { role: "PATIENT", text: "Feeling tired today.", source: "PATIENT" },
    { role: "JAGAON_KIND_SENTENCE", text: "That sounds like a tiring day. Thank you for telling me.", source: "REVIEWED_BANK" },
  ],
  themes: ["SLEEP"],
  aiUsed: true,
  promptVersion: "feelings-chat-prompt.1",
};

function ports(view: VisitPreparationView | Error, commit: { kind: string; recordId?: string; revisionId?: string } = { kind: "COMMITTED", recordId: "rec-q-1", revisionId: "rev-q-1" }) {
  const createCareQuestion = vi.fn(async (_input: unknown) => commit);
  const createPersonalNote = vi.fn(async (_input: unknown) => ({ kind: "COMMITTED", recordId: "rec-n-1", revisionId: "rev-n-1" }));
  const loadVisitPreparation = vi.fn(async () => {
    if (view instanceof Error) throw view;
    return view;
  });
  const storage = createFeelingsChatStorage({ notes: { createPersonalNote }, careOrganisation: { commands: { createCareQuestion }, query: { loadVisitPreparation } } } as unknown as FeelingsChatStoragePorts);
  return { storage, createCareQuestion, createPersonalNote };
}

const ready = (appointment: typeof APPOINTMENT | null) => ({ status: "READY", appointment, questions: [], factGroups: [], period: {} }) as unknown as VisitPreparationView;

describe("feelings-chat storage", () => {
  it("adds her doctor question as the visit-preparation screen does, linked to the appointment shown there, and returns its exact revision", async () => {
    const { storage, createCareQuestion } = ports(ready(APPOINTMENT));
    expect(await storage.addDoctorQuestion("I sleep 4 hours. Could this matter?")).toEqual({ recordType: "CARE_QUESTION", recordId: "rec-q-1", revisionId: "rev-q-1" });
    expect(createCareQuestion).toHaveBeenCalledWith({
      questionText: { text: "I sleep 4 hours. Could this matter?", language: "und" },
      relatedAppointment: { recordType: "APPOINTMENT", recordId: APPOINTMENT.recordId, revisionId: APPOINTMENT.revisionId },
    });
  });

  it.each<[string, VisitPreparationView | Error]>([
    ["no appointment", ready(null)],
    ["visit preparation unavailable", { status: "UNAVAILABLE" }],
    ["visit preparation failing", new Error("synthetic")],
  ])("%s: the question is still added, unlinked", async (_name, view) => {
    const { storage, createCareQuestion } = ports(view);
    expect(await storage.addDoctorQuestion("Could this matter?")).not.toBeNull();
    expect(createCareQuestion).toHaveBeenCalledWith({ questionText: { text: "Could this matter?", language: "und" } });
  });

  it("a refused care question resolves null", async () => {
    expect(await ports(ready(APPOINTMENT), { kind: "FAILED" }).storage.addDoctorQuestion("Could this matter?")).toBeNull();
  });

  it("saves the note in en-SG with the care-question link (or none)", async () => {
    const { storage, createPersonalNote } = ports(ready(null));
    expect(await storage.saveNote(NOTE, { recordType: "CARE_QUESTION", recordId: "rec-q-1", revisionId: "rev-q-1" } as never)).toBe(true);
    expect(createPersonalNote).toHaveBeenLastCalledWith({ payload: { ...NOTE, language: "en-SG", careQuestionRef: { recordType: "CARE_QUESTION", recordId: "rec-q-1", revisionId: "rev-q-1" } } });
    expect(await storage.saveNote({ ...NOTE, aiUsed: false, promptVersion: null }, null)).toBe(true);
    expect(createPersonalNote).toHaveBeenLastCalledWith({ payload: { ...NOTE, aiUsed: false, promptVersion: null, language: "en-SG", careQuestionRef: null } });
  });

  it("never throws: a failing note command resolves false", async () => {
    const createPersonalNote = vi.fn(async () => {
      throw new Error("synthetic");
    });
    const storage = createFeelingsChatStorage({ notes: { createPersonalNote }, careOrganisation: { commands: { createCareQuestion: vi.fn() }, query: { loadVisitPreparation: vi.fn() } } } as unknown as FeelingsChatStoragePorts);
    expect(await storage.saveNote(NOTE, null)).toBe(false);
  });
});
