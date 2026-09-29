// Public barrel for the shared domain kernel.
// Re-exports only the approved public interfaces from Tasks 1–5.
// Entity modules consume these primitives; no database, repository, or
// entity-payload types belong here.

// Task 1: validation outcomes
export {
  DomainValidationCode,
  domainValidationCodeSchema,
} from "./validation";

// Task 1: branded identifiers
export {
  recordIdSchema,
  revisionIdSchema,
  auditEventIdSchema,
  transactionIdSchema,
  createRecordId,
  createRevisionId,
  createAuditEventId,
  createTransactionId,
  type RecordId,
  type RevisionId,
  type AuditEventId,
  type TransactionId,
} from "./identifiers";

// Task 1: UTC instants and local dates
export {
  instantSchema,
  localDateSchema,
  isValidIanaTimeZoneId,
  compareInstants,
  instantBefore,
  instantAfter,
  instantEqual,
  type Instant,
  type LocalDate,
} from "./time";

// Task 2: temporal meaning
export {
  timePointSchema,
  intervalEndSchema,
  temporalMeaningSchema,
  type TimePoint,
  type IntervalEnd,
  type TemporalMeaning,
} from "./temporal";

// Task 3: record catalogue and authoritative owners
export {
  RECORD_TYPES,
  recordTypeSchema,
  AUTHORITATIVE_OWNERS,
  authoritativeOwnerSchema,
  recordOwnerByType,
  getAuthoritativeOwner,
  isOwnedBy,
  DeletionPolicy,
  deletionPolicySchema,
  PrescriptionChangeCandidateState,
  prescriptionChangeCandidateStateSchema,
  type RecordType,
  type AuthoritativeOwner,
} from "./record-catalogue";

// Task 4: provenance primitives
export {
  knowledgeClassSchema,
  sourceKindSchema,
  captureMethodSchema,
  changeInitiatorSchema,
  assistanceSchema,
  provenanceCoreSchema,
  type KnowledgeClass,
  type SourceKind,
  type CaptureMethod,
  type ChangeInitiator,
  type Assistance,
  type ProvenanceCore,
} from "./provenance";

// Task 4: audit
export {
  auditActionSchema,
  type AuditAction,
  type DomainMutationAudit,
} from "./audit";

// Task 5: revision, head, lineage validation
export {
  REVISION_ACTIONS,
  revisionActionSchema,
  createRecordRevisionSchema,
  recordHeadSchema,
  validateRevisionLineage,
  validateExpectedHead,
  assertActionableHead,
  type RevisionAction,
  type RecordRevision,
  type RecordHead,
  type ValidationResult,
} from "./revision";

// Task 5: deletion tombstone
export {
  deletionTombstoneSchema,
  type DeletionTombstone,
} from "./deletion";

// Packet 2B: shared text validation
export {
  countCodePoints,
  createBoundedTextSchema,
} from "./text";