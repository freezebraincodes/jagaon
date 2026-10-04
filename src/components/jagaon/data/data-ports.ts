import type { ConfirmDeletionResult, DeletionConfirmation, DeletionPlan, DeletionTarget, PrepareDeletionResult } from "@/application/deletion/deletion-contracts";
import type { DeleteAllEvents, DeleteAllPlan, DeleteAllResult } from "@/storage/delete-dataset";
import type { BackupExportResult, BackupExportStep } from "@/backup/backup-export-service";

/** UI-facing Packet 10 ports; components never touch Dexie or stored rows. */
export type DeleteAllPort = {
  prepare(): DeleteAllPlan;
  confirm(plan: DeleteAllPlan, typedToken: string, events?: DeleteAllEvents): Promise<DeleteAllResult>;
};

export type RecordDeletionPort = {
  prepare(target: DeletionTarget): Promise<PrepareDeletionResult>;
  confirm(plan: DeletionPlan, confirmation: DeletionConfirmation): Promise<ConfirmDeletionResult>;
};

export type BackupExportPort = {
  export(request: { passphrase: string; confirmation: string }, events?: { onStepCompleted?(step: BackupExportStep): void }): Promise<BackupExportResult>;
};

export type RestorePort = {
  inspect(file: Uint8Array, passphrase: string): Promise<import("@/application/restore/restore-contracts").InspectRestoreResult>;
  confirm(
    plan: import("@/application/restore/restore-contracts").RestorePlan,
    confirmation: import("@/application/restore/restore-contracts").RestoreConfirmation,
  ): Promise<import("@/application/restore/restore-contracts").ConfirmRestoreResult>;
};

/** Resolves when the restored dataset finished durable reconciliation, or reports a lock. */
export type AwaitReconciliation = () => Promise<"COMPLETED" | "LOCKED">;
