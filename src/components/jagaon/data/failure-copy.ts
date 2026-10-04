import type { AppMessages } from "@/i18n/types";
import type { StorageFailureMessageKey } from "@/storage/storage-failure";

/**
 * Resolves a closed storage-failure message key (storage-backup-spec 9.2) to
 * one approved catalogue string. Exception text is never displayed.
 */
export function failureMessage(messages: AppMessages, key: StorageFailureMessageKey): string {
  const p = messages.packet10;
  switch (key) {
    case "shared.storageUnavailable":
      return messages.shared.storageUnavailable;
    case "shared.notSaved":
      return messages.shared.notSaved;
    case "packet10.shared.recordsUnchanged":
      return p.shared.recordsUnchanged;
    case "packet10.integrity.integrityBody":
      return p.integrity.integrityBody;
    case "packet10.integrity.migrationBlocked":
      return p.integrity.migrationBlocked;
    case "packet10.integrity.newerDatabase":
      return p.integrity.newerDatabase;
    case "packet10.deletion.deletionChanged":
      return p.deletion.deletionChanged;
    case "packet10.deletion.deleteBlocked":
      return p.deletion.deleteBlocked;
    case "packet10.backup.backupFailed":
      return p.backup.backupFailed;
    case "packet10.backup.backupTooLarge":
      return p.backup.backupTooLarge;
    case "packet10.restore.authenticationFailed":
      return p.restore.authenticationFailed;
    case "packet10.restore.unsupportedVersion":
      return p.restore.unsupportedVersion;
    case "packet10.restore.differentDataset":
      return p.restore.differentDataset;
    case "packet10.restore.restoreFailed":
      return p.restore.restoreFailed;
    case "packet10.restore.recoveryRequired":
      return p.restore.recoveryRequired;
  }
}

/** Locale-aware integer formatting for count parameters. */
export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
