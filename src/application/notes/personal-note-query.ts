import type { Instant, RecordHead, RecordId, RevisionId } from "@/domain/shared";
import type { NoteThemeKey } from "@/domain/notes/note-themes";
import { PERSONAL_NOTE_RECORD_TYPE, type PersonalNotePayload, type PersonalNoteRevision } from "@/domain/notes/personal-note";
import type { JagaOnDatabase } from "@/storage/database";
import { personalNoteRevisionCodec } from "./personal-note-persistence";

/**
 * Owner decision 2026-10-14 (My notes): the personal-note read projection. Only ACTIVE heads are read (a deleted note has no revision
 * left); every row is validated by the owner codec on read, and an integrity failure propagates (never an empty success).
 * - `listPersonalNotes()`: newest first by the revision's `recordedAt` (the save instant).
 * - `themeCounts({ now, days })`: how many notes saved in the last `days` days (default 7, ending at `now`) carry each theme; only
 *   themes with at least one note, most frequent first, then by theme key.
 */
export type PersonalNoteView = Readonly<{
  recordId: RecordId;
  revisionId: RevisionId;
  recordedAt: Instant;
  payload: PersonalNotePayload;
}>;

export type NoteThemeCount = Readonly<{ theme: NoteThemeKey; count: number }>;

export type PersonalNoteQueryPort = Readonly<{
  listPersonalNotes(): Promise<readonly PersonalNoteView[]>;
  themeCounts(request: Readonly<{ now: Instant | string; days?: number }>): Promise<readonly NoteThemeCount[]>;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function createPersonalNoteQuery(database: JagaOnDatabase): PersonalNoteQueryPort {
  async function listPersonalNotes(): Promise<readonly PersonalNoteView[]> {
    const heads = ((await database.table("recordHeads").where("recordType").equals(PERSONAL_NOTE_RECORD_TYPE).toArray()) as RecordHead[]).filter((head) => head.state === "ACTIVE");
    const notes: PersonalNoteView[] = [];
    for (const head of heads) {
      const raw = await database.table("recordRevisions").get(head.headRevisionId);
      if (raw === undefined) continue;
      const revision = personalNoteRevisionCodec.validateAfterRead(raw).revision as PersonalNoteRevision;
      notes.push(Object.freeze({ recordId: head.recordId, revisionId: head.headRevisionId, recordedAt: revision.recordedAt, payload: revision.payload }));
    }
    notes.sort((left, right) => (left.recordedAt === right.recordedAt ? (left.recordId < right.recordId ? 1 : -1) : left.recordedAt < right.recordedAt ? 1 : -1));
    return Object.freeze(notes);
  }

  async function themeCounts(request: Readonly<{ now: Instant | string; days?: number }>): Promise<readonly NoteThemeCount[]> {
    const end = Date.parse(request.now);
    const days = request.days ?? 7;
    if (!Number.isFinite(end) || !Number.isFinite(days) || days <= 0) return Object.freeze([]);
    const start = end - days * DAY_MS;
    const counts = new Map<NoteThemeKey, number>();
    for (const note of await listPersonalNotes()) {
      const at = Date.parse(note.recordedAt);
      if (!(at > start && at <= end)) continue;
      for (const theme of new Set(note.payload.themes)) counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
    return Object.freeze(
      [...counts.entries()]
        .filter(([, count]) => count >= 1)
        .sort(([leftTheme, leftCount], [rightTheme, rightCount]) => rightCount - leftCount || (leftTheme < rightTheme ? -1 : leftTheme > rightTheme ? 1 : 0))
        .map(([theme, count]) => Object.freeze({ theme, count })),
    );
  }

  return Object.freeze({ listPersonalNotes, themeCounts });
}
