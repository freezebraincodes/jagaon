/**
 * Packet 10 typed message hierarchy (10-bilingual-copy-matrix.md, final
 * section). Every value is an APPROVED_PACKET_10 row, the LOCKED_TOKEN, or a
 * typed function whose parameters are locale-formatted data. The two
 * DESIGN_ANNOTATION_NOT_SHIPPED rows (`focusNote`, `intOtherK`) and the
 * PARAMETER_ONLY rows (`recordName`, `recordWhen`) have no catalogue string.
 */
export type Packet10Messages = {
  more: { data: string; dataSub: string };
  hub: {
    title: string;
    intro: string;
    liveStorage: string;
    liveStorageLimit: string;
    createBackup: string;
    restoreBackup: string;
    deleteAll: string;
    deleteAllHelp: string;
    offline: string;
    hubLast: string;
  };
  backup: {
    backupTitle: string;
    backupBody: string;
    passphrase: string;
    confirmPassphrase: string;
    passphraseHelp: string;
    passphraseLoss: string;
    passphraseMismatch: string;
    createAction: string;
    preparing: string;
    downloadStarted: string;
    fileWriteConfirmed: string;
    saveCancelled: string;
    backupFailed: string;
    backupTooLarge: string;
    fileNameNote: (fileName: string) => string;
    fileK: string;
    preparedAt: (time: string) => string;
    stepsDone: string;
    prepSteps: readonly [string, string, string, string];
    notProof: string;
    fileContains: string;
    recordsUnchanged: string;
  };
  restore: {
    restoreTitle: string;
    chooseFile: string;
    restorePassphrase: string;
    inspectAction: string;
    checking: string;
    authenticationFailed: string;
    authHelp: string;
    unsupportedVersion: string;
    differentDataset: string;
    untrusted: string;
    fileSize: (size: string) => string;
    planBackupK: string;
    planExported: (date: string) => string;
    planCounts: {
      glucoseReadings: (n: string) => string;
      medicineEntries: (n: string) => string;
      mealEntries: (n: string) => string;
      healthChecksAppointments: (n: string) => string;
    };
    emptyPlan: string;
    replacementPlan: (date: string) => string;
    willBeLostK: string;
    willBeLostV: (n: string) => string;
    deletionProtected: (count: string) => string;
    freshBackupFirst: string;
    externalUnchanged: string;
    planExpires: string;
    restoreEmptyAction: string;
    restoreConfirm: string;
    restoring: string;
    restoreSteps: readonly [string, string, string, string, string];
    noFaster: string;
    reconciling: string;
    restoreDone: string;
    doneSummaryK: string;
    doneNoShare: string;
    restoreFailed: string;
    recoveryRequired: string;
    whatChangedK: string;
    blockWritten: string;
    blockNotRebuilt: string;
    blockLocked: string;
  };
  deletion: {
    deleteRecordTitle: string;
    deleteRecordBody: string;
    externalCopiesRemain: string;
    deleteRecordAction: string;
    deletionChanged: string;
    recordK: string;
    planK: string;
    deletePlanItems: { self: string; dependent: (n: string) => string; none: string };
    keepRecord: string;
    deleteAllTitle: string;
    deleteAllBody: string;
    deleteAllCopies: string;
    deleteAllAction: string;
    typeToConfirm: string;
    deleteConfirmToken: "DELETE";
    keepData: string;
    deleteBlocked: string;
    deleteBlockedUnchanged: string;
    deleteAllDone: string;
  };
  integrity: {
    integrityTitle: string;
    integrityBody: string;
    migrationBlocked: string;
    newerDatabase: string;
    intDisabled: string;
    intUnchangedLock: string;
    intVariantMigrationK: string;
    intVariantNewerK: string;
    retryRecovery: string;
    openBackupRecovery: string;
  };
  shared: { show: string; done: string; cancel: string; change: string; openToday: string; noHealthClaim: string; recordsUnchanged: string };
};
