/**
 * Closed physical Dexie table and index catalogue for the first complete
 * JagaOn storage schema.
 *
 * Implements storage-backup-spec.md Section 2.1 (database identity and closed
 * table list) and Sections 2.2-2.9 (primary keys and required indexes). This
 * module is declarative: it defines only constants and a derived type. It does
 * not open IndexedDB and does not construct a Dexie instance.
 *
 * Row shapes remain typed as `never` at the database layer until Packet 4F2
 * supplies exact validated row adapters. No convenience index, generic
 * key-value table, or multi-patient escape-hatch field is introduced here.
 */

/**
 * Stable logical application database name.
 *
 * Spec Section 2.1: the MVP uses one IndexedDB database with the stable logical
 * name `jagaon`.
 */
export const JAGAON_DATABASE_NAME = "jagaon" as const;

/**
 * Current Dexie physical schema version.
 *
 * A positive whole number owned by Dexie's monotonic upgrade counter. The
 * logical storage schema version is tracked separately (storageMetadata) so
 * backup/runtime compatibility does not depend on this library counter.
 * Version 2 (Packet 10 freeze Section 5) keeps the version 1 stores exactly
 * and adds only the registered legacy dataset-identity upgrade step.
 */
export const JAGAON_DEXIE_VERSION = 2 as const;

/** The first physical schema version, kept so a Packet 9 database can upgrade. */
export const JAGAON_LEGACY_DEXIE_VERSION = 1 as const;

/**
 * Closed, spec-ordered, duplicate-free list of the 16 first-schema tables.
 *
 * Order follows the `JagaOnTableName` union in storage-backup-spec.md
 * Section 2.1. A new table requires an approved storage-specification revision
 * and migration; it cannot be added here as a convenience.
 */
export const JAGAON_TABLE_NAMES = Object.freeze([
  "appPreferences",
  "recordRevisions",
  "recordHeads",
  "deletionTombstones",
  "auditEvents",
  "domainEvents",
  "commandReceipts",
  "eventWorkItems",
  "eventConsumerReceipts",
  "reverseDependencies",
  "engineEvaluationAudits",
  "aiInvocationAudits",
  "runtimeManifests",
  "governedAssets",
  "runtimeActivationAudits",
  "storageMetadata",
] as const);

/**
 * Every physical table name in the first complete JagaOn schema.
 *
 * Derived from {@link JAGAON_TABLE_NAMES} so the type cannot drift from the
 * runtime catalogue.
 */
export type JagaOnTableName = (typeof JAGAON_TABLE_NAMES)[number];

/**
 * Exact Dexie store schema strings for physical version 1.
 *
 * Each value is the Dexie `.stores()` argument for one table. The first token
 * is the primary key (optionally `&` for uniqueness, or a compound `[a+b]`).
 * Subsequent comma-separated tokens are secondary indexes; `&` marks a unique
 * secondary index and `[a+b]` marks a compound index. No convenience index is
 * added beyond those required by storage-backup-spec.md Sections 2.2-2.9.
 *
 * Compound primary keys are inherently unique in IndexedDB, so no leading `&`
 * is used for them.
 */
export const JAGAON_STORES_V1: Readonly<Record<JagaOnTableName, string>> = Object.freeze({
  // Section 2.9: key is the primary key. updatedAt remains a future row
  // field but is not an IndexedDB index.
  appPreferences: "key",

  // Section 2.2: revisionId PK; unique [recordId+revisionNumber]; temporal +
  // lineage indexes.
  recordRevisions:
    "revisionId, recordId, recordType, previousRevisionId, transactionId, auditEventId, revisionCreatedAt, [recordId+revisionNumber]&, [recordType+recordedAt], [recordType+occurrenceSortInstant], [recordType+effectiveStartSortInstant], [recordType+localDateSortKey]",

  // Section 2.3: recordId PK; recordType, headRevisionId, state, updatedAt.
  recordHeads: "recordId, recordType, headRevisionId, state, updatedAt",

  // Section 2.3: recordId PK; recordType, deletedAt, auditEventId,
  // transactionId. No payload field.
  deletionTombstones:
    "recordId, recordType, deletedAt, auditEventId, transactionId",

  // Section 2.4: auditEventId PK; recordId, transactionId, occurredAt,
  // [recordId+occurredAt].
  auditEvents:
    "auditEventId, recordId, transactionId, occurredAt, [recordId+occurredAt]",

  // Section 2.4: eventId PK; unique localSequence; eventName, transactionId,
  // commandId, correlationId, committedAt, [eventName+localSequence].
  domainEvents:
    "eventId, &localSequence, eventName, transactionId, commandId, correlationId, committedAt, [eventName+localSequence]",

  // Section 2.4: commandId PK; outcome, completedAt, optional transactionId.
  commandReceipts: "commandId, outcome, completedAt, transactionId",

  // Section 2.5: workItemId PK; unique [eventId+consumer+handlerVersion];
  // scheduling indexes.
  eventWorkItems:
    "workItemId, eventId, consumer, handlerVersion, stateCode, sourceEventSequence, leaseExpiresAt, [eventId+consumer+handlerVersion]&, [stateCode+priorityRank+availableAt+sourceEventSequence], [stateCode+leaseExpiresAt]",

  // Section 2.4: unique compound [eventId+consumer+handlerVersion] PK;
  // eventId, consumer, completedAt.
  eventConsumerReceipts:
    "[eventId+consumer+handlerVersion], eventId, consumer, completedAt",

  // Section 2.6: unique compound
  // [sourceRevisionId+dependentRevisionId+dependencyRole] PK; edge indexes.
  reverseDependencies:
    "[sourceRevisionId+dependentRevisionId+dependencyRole], sourceRevisionId, dependentRecordId, dependentRevisionId, owner, [dependentRecordId+dependentRevisionId]",

  // Section 2.7: evaluationId PK; engine, evaluatedAt, runtimeManifestId,
  // inputFingerprint, resultFingerprint, [engine+evaluatedAt].
  engineEvaluationAudits:
    "evaluationId, engine, evaluatedAt, runtimeManifestId, inputFingerprint, resultFingerprint, [engine+evaluatedAt]",

  // Section 2.7: requestId PK; taskType, requestedAt, outcomeCode,
  // routeProfileKey, [taskType+requestedAt].
  aiInvocationAudits:
    "requestId, taskType, requestedAt, outcomeCode, routeProfileKey, [taskType+requestedAt]",

  // Section 2.8: unique compound [manifestId+manifestVersion] PK; lifecycle,
  // effectiveFrom, expiresAt, [lifecycle+effectiveFrom].
  runtimeManifests:
    "[manifestId+manifestVersion], lifecycle, effectiveFrom, expiresAt, [lifecycle+effectiveFrom]",

  // Section 2.8: unique compound [assetKey+assetVersion] PK. No required
  // secondary indexes specified.
  governedAssets: "[assetKey+assetVersion]",

  // Section 2.8: activationAuditId PK; runtimeKind, action, evaluatedAt,
  // resultingVersionKey, [runtimeKind+evaluatedAt].
  runtimeActivationAudits:
    "activationAuditId, runtimeKind, action, evaluatedAt, resultingVersionKey, [runtimeKind+evaluatedAt]",

  // Section 2.9: closed string PK. Discriminated value not indexed.
  storageMetadata: "key",
});
