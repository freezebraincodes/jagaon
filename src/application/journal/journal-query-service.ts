import type {
  JournalQueryPort,
  TodayJournalViewModel,
  TodayJournalEntry,
  GlucoseRecordViewModel,
  JournalEntryKind,
} from "./journal-contracts";
import type { JagaOnDatabase } from "@/storage/database";
import type { Instant } from "@/domain/shared/time";
import type { RecordId } from "@/domain/shared/identifiers";
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import type { ReadingTemporal } from "@/domain/health-records/reading-temporal";
import { validatePacket6StoredRevision } from "./journal-row-codecs";

const PACKET6_RECORD_TYPES: ReadonlySet<JournalEntryKind> = new Set([
  "GLUCOSE_READING",
  "MEDICATION_EVENT",
  "INTAKE_EVENT",
]);

const MAX_TODAY_ENTRIES = 20;

export function createJournalQueryService(
  database: JagaOnDatabase,
): JournalQueryPort {
  async function loadToday(): Promise<TodayJournalViewModel> {
    try {
      const heads = (await database
        .table("recordHeads")
        .toArray()) as Array<{
        recordId: RecordId;
        recordType: string;
        headRevisionId: string;
        headRevisionNumber: number;
        state: string;
        updatedAt: string;
      }>;

      // Filter to Packet 6 active heads only
      const activeHeads = heads.filter(
        (head) =>
          head.state === "ACTIVE" &&
          PACKET6_RECORD_TYPES.has(head.recordType as JournalEntryKind),
      );

      if (activeHeads.length === 0) {
        return { entries: [], unavailable: false };
      }

      // Fetch the head revisions for each active head
      const headRevisionIds = activeHeads.map(
        (head) => head.headRevisionId,
      );
      const revisions = (await database
        .table("recordRevisions")
        .where("revisionId")
        .anyOf(headRevisionIds)
        .toArray()) as Array<Record<string, unknown>>;

      // Build a map of revisionId -> validated revision. A malformed or
      // missing active head is a storage-integrity failure: do not render a
      // partial Today view that could silently hide a patient-authored row.
      const revisionMap = new Map<string, ReturnType<typeof validatePacket6StoredRevision>>();
      for (const row of revisions) {
        try {
          const validated = validatePacket6StoredRevision(row);
          revisionMap.set(validated.revisionId, validated);
        } catch {
          return { entries: [], unavailable: true };
        }
      }

      if (revisionMap.size !== activeHeads.length) {
        return { entries: [], unavailable: true };
      }

      const entries: TodayJournalEntry[] = [];
      for (const head of activeHeads) {
        const stored = revisionMap.get(head.headRevisionId);
        if (!stored) {
          return { entries: [], unavailable: true };
        }

        const innerRevision = stored.revision;
        const occurrenceSortInstant = resolveOccurrenceInstant(
          innerRevision.temporal,
        );
        const summary = buildSummary(innerRevision);

        entries.push({
          recordId: stored.recordId,
          revisionId: stored.revisionId,
          recordType: stored.recordType as JournalEntryKind,
          revisionNumber: stored.revisionNumber,
          recordedAt: stored.recordedAt as Instant,
          occurrenceSortInstant,
          summary,
          ...buildDisplayFields(innerRevision),
        });
      }

      // Sort by occurrence time descending (nulls last), then by recordedAt
      entries.sort((a, b) => {
        const aSort = a.occurrenceSortInstant ?? a.recordedAt;
        const bSort = b.occurrenceSortInstant ?? b.recordedAt;
        return bSort.localeCompare(aSort);
      });

      return {
        entries: entries.slice(0, MAX_TODAY_ENTRIES),
        unavailable: false,
      };
    } catch {
      return { entries: [], unavailable: true };
    }
  }

  async function loadGlucose(
    recordId: RecordId,
  ): Promise<GlucoseRecordViewModel | null> {
    try {
      const head = (await database
        .table("recordHeads")
        .where("recordId")
        .equals(recordId)
        .first()) as
        | {
            recordId: RecordId;
            recordType: string;
            headRevisionId: string;
            headRevisionNumber: number;
            state: string;
          }
        | undefined;

      if (!head || head.recordType !== "GLUCOSE_READING") {
        return null;
      }

      const revisionRow = (await database
        .table("recordRevisions")
        .where("revisionId")
        .equals(head.headRevisionId)
        .first()) as Record<string, unknown> | undefined;

      if (!revisionRow) return null;

      const stored = validatePacket6StoredRevision(revisionRow);
      if (stored.recordType !== "GLUCOSE_READING") return null;

      const revision = stored.revision;
      return {
        recordId: stored.recordId,
        revisionId: stored.revisionId,
        revisionNumber: stored.revisionNumber,
        recordedAt: stored.recordedAt as Instant,
        payload: revision.payload as GlucoseReadingPayload,
        temporal: revision.temporal as ReadingTemporal,
      };
    } catch {
      return null;
    }
  }

  return Object.freeze({ loadToday, loadGlucose });
}

function buildDisplayFields(revision: {
  recordType: string;
  payload: unknown;
}): Pick<TodayJournalEntry, "displayValue" | "displayUnit" | "displayContext"> {
  if (revision.recordType === "GLUCOSE_READING") {
    const payload = revision.payload as GlucoseReadingPayload;
    const context = payload.context;
    return {
      displayValue: payload.measurement.enteredValue,
      displayUnit: payload.measurement.enteredUnit === "MMOL_L" ? "mmol/L" : "mg/dL",
      displayContext:
        context.kind === "PATIENT_SELECTED_SLOT" ? context.slot : context.kind,
    };
  }

  if (revision.recordType === "MEDICATION_EVENT") {
    const payload = revision.payload as {
      medication?: { recordId?: string };
      amountTaken?: {
        kind?: string;
        amount?: { value?: string; unit?: string };
      };
    };
    const amount = payload.amountTaken;
    // The amount and its domain unit code stay separate so the UI can label
    // the unit in the active locale instead of showing the raw code.
    return amount?.kind === "KNOWN" && amount.amount?.value
      ? {
          displayContext: payload.medication?.recordId,
          displayValue: amount.amount.value,
          displayUnit: amount.amount.unit,
        }
      : { displayContext: payload.medication?.recordId };
  }

  if (revision.recordType === "INTAKE_EVENT") {
    const payload = revision.payload as {
      intakeKind?: string;
      intakeSlot?: { code?: string };
      items?: Array<{ label?: string }>;
    };
    // The meal slot when one was chosen, otherwise the intake kind.
    return {
      displayContext: payload.intakeSlot?.code ?? payload.intakeKind,
      displayValue: payload.items?.[0]?.label,
    };
  }

  return {};
}

function resolveOccurrenceInstant(
  temporal: unknown,
): Instant | null {
  const t = temporal as {
    kind: string;
    occurrence?: {
      kind: string;
      instantUtc?: string;
      approximateInstantUtc?: string;
    };
  };
  if (t.kind !== "POINT" || !t.occurrence) return null;
  const occ = t.occurrence;
  if (occ.kind === "EXACT" && occ.instantUtc) {
    return occ.instantUtc as Instant;
  }
  if (occ.kind === "APPROXIMATE" && occ.approximateInstantUtc) {
    return occ.approximateInstantUtc as Instant;
  }
  return null;
}

function buildSummary(revision: {
  recordType: string;
  payload: unknown;
}): string {
  const p = revision.payload as Record<string, unknown>;
  if (revision.recordType === "GLUCOSE_READING") {
    const measurement = p.measurement as { enteredValue?: string } | null;
    const value = measurement?.enteredValue ?? "?";
    const method = p.measurementMethod as string | undefined;
    return `${value} mmol/L${method ? ` · ${method}` : ""}`;
  }
  if (revision.recordType === "MEDICATION_EVENT") {
    const amountTaken = p.amountTaken as {
      kind: string;
      amount?: { value?: string; unit?: string };
    } | null;
    const amount =
      amountTaken?.kind === "KNOWN"
        ? `${amountTaken.amount?.value ?? "?"} ${amountTaken.amount?.unit ?? ""}`
        : "—";
    return `Insulin · ${amount}`;
  }
  if (revision.recordType === "INTAKE_EVENT") {
    const items = p.items as Array<{ label?: string }> | undefined;
    const firstItem = items?.[0]?.label ?? "Meal";
    const slot = p.intakeSlot as { code?: string } | undefined;
    const slotCode = slot?.code ?? "";
    return `${slotCode} · ${firstItem}`;
  }
  return "";
}
