import type { RecordHead, RecordId } from "@/domain/shared";
import type { JagaOnDatabase } from "@/storage/database";
import { carePreparationRevisionRowCodec } from "./care-preparation-persistence";
import { sourcesAreCurrent } from "./care-summary-candidates";
import type { CarePreparationQueryPort, CareSummaryExportView, CareSummaryView } from "./care-preparation-contracts";

/**
 * Packet 9C read projection for the preview route. It relays the stored
 * snapshot exactly, checks live whether every included source is still its
 * exact current revision, and lists this snapshot's print attempts.
 */
export function createCarePreparationQuery(database: JagaOnDatabase): CarePreparationQueryPort {
  return Object.freeze({
    async loadSummary(recordId: RecordId): Promise<CareSummaryView> {
      try {
        const head = (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
        if (!head || head.state !== "ACTIVE" || head.recordType !== "CARE_SUMMARY_SNAPSHOT") return { status: "NOT_FOUND" };
        const revision = carePreparationRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision;
        if (revision.recordType !== "CARE_SUMMARY_SNAPSHOT") return { status: "NOT_FOUND" };
        const exports: CareSummaryExportView[] = [];
        for (const exportHead of (await database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_EXPORT").toArray()) as RecordHead[]) {
          if (exportHead.state !== "ACTIVE") continue;
          const exportRevision = carePreparationRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(exportHead.headRevisionId)).revision;
          if (exportRevision.recordType !== "CARE_SUMMARY_EXPORT" || exportRevision.payload.snapshot.recordId !== recordId) continue;
          exports.push({ recordId: exportRevision.recordId, revisionNumber: exportRevision.revisionNumber, requestedAt: exportRevision.payload.requestedAt, outcome: exportRevision.payload.outcome });
        }
        exports.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.recordId.localeCompare(b.recordId));
        return {
          status: "READY",
          recordId: head.recordId,
          revisionId: head.headRevisionId,
          revisionNumber: head.headRevisionNumber,
          snapshotStatus: revision.payload.status,
          payload: revision.payload,
          sourcesCurrent: await sourcesAreCurrent(database, revision.payload.selection.includedSourceRevisions),
          exports,
        };
      } catch {
        return { status: "UNAVAILABLE" };
      }
    },
  });
}
