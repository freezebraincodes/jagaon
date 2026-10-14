import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeletionPlan } from "@/application/deletion/deletion-contracts";
import type { NoteThemeCount, PersonalNoteQueryPort, PersonalNoteView } from "@/application/notes/personal-note-query";
import type { PersonalNotePayload } from "@/domain/notes/personal-note";
import { getMessages } from "@/i18n/get-messages";
import type { RecordDeletionPort } from "../data/data-ports";
import { formatSingaporeDateTime } from "../journal/singapore-time";
import { MyNotesScreen } from "./MyNotesScreen";

/** Owner decision 2026-10-14 (My notes): the stored notes list, this week's themes and deleting one note. Synthetic notes only. */
afterEach(() => cleanup());

const en = getMessages("en-SG");
const msg = en.myNotes;
const NOW = "2026-10-14T02:00:00.000Z";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function view(n: number, recordedAt: string, overrides: Partial<PersonalNotePayload> = {}): PersonalNoteView {
  return {
    recordId: ID(n) as never,
    revisionId: ID(100 + n) as never,
    recordedAt: recordedAt as never,
    payload: { text: `Note ${n} (synthetic).`, language: "en-SG", feelingCues: [], turns: [], themes: [], aiUsed: false, promptVersion: null, careQuestionRef: null, ...overrides },
  };
}

function fakeQuery(initial: PersonalNoteView[], counts: NoteThemeCount[] = []) {
  const state = { notes: [...initial], counts: [...counts] };
  const query: PersonalNoteQueryPort = {
    listPersonalNotes: vi.fn(async () => state.notes),
    themeCounts: vi.fn(async () => state.counts),
  };
  return { state, query };
}

function plan(recordId: string): DeletionPlan {
  return {
    planHash: "a".repeat(64) as never,
    createdAt: NOW as never,
    expiresAt: "2026-10-14T02:10:00.000Z" as never,
    target: { recordType: "PERSONAL_NOTE", recordId: recordId as never },
    closure: {} as never,
    closureFingerprint: "",
    neutralisedReceipts: [],
    effects: { targetRecordType: "PERSONAL_NOTE", dependentCount: 0, externalCopiesNotRecalled: true },
  };
}

describe("MyNotesScreen", () => {
  it("shows the empty line without a notes port, and when no note is stored (both locales)", async () => {
    render(<MyNotesScreen messages={en} />);
    expect(screen.getByRole("heading", { level: 1, name: msg.title })).toBeInTheDocument();
    expect(screen.getByText(msg.empty)).toBeInTheDocument();
    cleanup();

    for (const locale of ["en-SG", "zh-SG"] as const) {
      const localized = getMessages(locale);
      const { query } = fakeQuery([]);
      render(<MyNotesScreen messages={localized} locale={locale} notes={{ query }} now={() => NOW} />);
      expect(screen.getByText(localized.myNotes.loading)).toBeInTheDocument();
      expect(await screen.findByText(localized.myNotes.empty)).toBeInTheDocument();
      expect(screen.queryByRole("list")).toBeNull();
      expect(query.themeCounts).toHaveBeenCalledWith({ now: NOW, days: 7 });
      cleanup();
    }
  });

  it("shows an unavailable message when the notes cannot be read (never an empty success)", async () => {
    const query: PersonalNoteQueryPort = { listPersonalNotes: vi.fn(async () => Promise.reject(new Error("locked"))), themeCounts: vi.fn(async () => []) };
    render(<MyNotesScreen messages={en} notes={{ query }} now={() => NOW} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(msg.unavailable);
    expect(screen.queryByText(msg.empty)).toBeNull();
  });

  it("lists notes newest first as given, with date and time, text and theme chips", async () => {
    const first = view(1, "2026-10-14T01:00:00.000Z", { text: "Slept badly again (synthetic).", themes: ["SLEEP", "HEALTH_OR_SUGAR"] });
    const second = view(2, "2026-10-12T11:30:00.000Z", { text: "Worried about money (synthetic)." });
    const { query } = fakeQuery([first, second]);
    render(<MyNotesScreen messages={en} notes={{ query }} now={() => NOW} />);
    const articles = await screen.findAllByRole("article");
    expect(articles).toHaveLength(2);
    expect(within(articles[0]!).getByRole("heading", { level: 2 })).toHaveTextContent(formatSingaporeDateTime("en-SG", first.recordedAt));
    expect(within(articles[0]!).getByText("Slept badly again (synthetic).")).toHaveAttribute("lang", "en-SG");
    const chips = within(articles[0]!).getByRole("list", { name: msg.themesLabel });
    expect(within(chips).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Sleep", "Health or sugar levels"]);
    expect(within(articles[1]!).getByText("Worried about money (synthetic).")).toBeInTheDocument();
    expect(within(articles[1]!).queryByRole("list", { name: msg.themesLabel })).toBeNull();
    // No delete action without the deletion port; no conversation without turns.
    expect(screen.queryByRole("button", { name: msg.deleteNote })).toBeNull();
    expect(document.querySelector("details")).toBeNull();
  });

  it("states this week's recurring themes, at most three lines", async () => {
    const { query } = fakeQuery(
      [view(1, NOW, { themes: ["SLEEP"] })],
      [
        { theme: "SLEEP", count: 3 },
        { theme: "FAMILY", count: 2 },
        { theme: "MONEY", count: 1 },
        { theme: "WORK", count: 1 },
      ],
    );
    render(<MyNotesScreen messages={en} notes={{ query }} now={() => NOW} />);
    const section = await screen.findByRole("region", { name: msg.themesHeading });
    expect(within(section).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Sleep came up in 3 notes this week.",
      "Family came up in 2 notes this week.",
      "Money came up in 1 note this week.",
    ]);
  });

  it("shows no theme lines when no theme came up this week", async () => {
    const { query } = fakeQuery([view(1, NOW)]);
    render(<MyNotesScreen messages={en} notes={{ query }} now={() => NOW} />);
    await screen.findByRole("article");
    expect(screen.queryByRole("region", { name: msg.themesHeading })).toBeNull();
  });

  it("keeps the conversation behind a note in a collapsible section", async () => {
    const turns: PersonalNotePayload["turns"] = [
      { role: "PATIENT", text: "I could not sleep.", source: "PATIENT" },
      { role: "JAGAON_QUESTION", text: "What kept you awake?", source: "AI_VALIDATED" },
      { role: "JAGAON_KIND_SENTENCE", text: "That sounds tiring.", source: "REVIEWED_BANK" },
    ];
    const { query } = fakeQuery([view(1, NOW, { turns, aiUsed: true, promptVersion: "feelings-chat.1" })]);
    render(<MyNotesScreen messages={en} notes={{ query }} now={() => NOW} />);
    const article = await screen.findByRole("article");
    const details = article.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText(msg.conversation).tagName).toBe("SUMMARY");
    expect([...details.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["You: I could not sleep.", "JagaOn: What kept you awake?", "JagaOn: That sounds tiring."]);
  });

  it("deletes one note through the permanent-deletion dialog and refreshes the list", async () => {
    const keep = view(1, "2026-10-14T01:00:00.000Z", { text: "Keep me (synthetic)." });
    const remove = view(2, "2026-10-13T01:00:00.000Z", { text: "Remove me (synthetic)." });
    const { state, query } = fakeQuery([keep, remove]);
    const deletion: RecordDeletionPort = {
      prepare: vi.fn(async (target) => ({ kind: "PLAN_READY" as const, plan: plan(target.recordId) })),
      confirm: vi.fn(async (deleted: DeletionPlan) => {
        state.notes = state.notes.filter((entry) => entry.recordId !== deleted.target.recordId);
        return { kind: "DELETED" } as never;
      }),
    };
    render(<MyNotesScreen messages={en} notes={{ query, deletion }} now={() => NOW} />);
    const articles = await screen.findAllByRole("article");
    fireEvent.click(within(articles[1]!).getByRole("button", { name: msg.deleteNote }));

    const dialog = screen.getByRole("alertdialog", { name: en.packet10.deletion.deleteRecordTitle });
    expect(deletion.prepare).toHaveBeenCalledWith({ recordType: "PERSONAL_NOTE", recordId: remove.recordId });
    expect(within(dialog).getByText(msg.noteRecordLabel)).toBeInTheDocument();
    expect(within(dialog).getByText(formatSingaporeDateTime("en-SG", remove.recordedAt))).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: en.packet10.deletion.deleteRecordAction });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByText("Remove me (synthetic).")).toBeNull());
    expect(deletion.confirm).toHaveBeenCalledWith(expect.objectContaining({ target: { recordType: "PERSONAL_NOTE", recordId: remove.recordId } }), { planHash: "a".repeat(64), confirmedAt: NOW });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Keep me (synthetic).")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(msg.deleted);
  });

  it("keeps the note when deletion is cancelled", async () => {
    const { query } = fakeQuery([view(1, NOW, { text: "Still here (synthetic)." })]);
    const deletion: RecordDeletionPort = { prepare: vi.fn(async (target) => ({ kind: "PLAN_READY" as const, plan: plan(target.recordId) })), confirm: vi.fn() };
    render(<MyNotesScreen messages={en} notes={{ query, deletion }} now={() => NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: msg.deleteNote }));
    fireEvent.click(screen.getByRole("button", { name: en.packet10.deletion.keepRecord }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(deletion.confirm).not.toHaveBeenCalled();
    expect(screen.getByText("Still here (synthetic).")).toBeInTheDocument();
  });
});
