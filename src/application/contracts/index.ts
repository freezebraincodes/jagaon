// Public barrel for Packet 4A: command/event identities and closed name
// catalogues. Re-exports only the approved contracts from this packet.

// Task 1: branded identifiers, sequence, origin, and cause
export {
  commandIdSchema,
  correlationIdSchema,
  domainEventIdSchema,
  eventSequenceSchema,
  createCommandId,
  createCorrelationId,
  createDomainEventId,
  COMMAND_ORIGINS,
  commandOriginSchema,
  commandCauseSchema,
  type CommandId,
  type CorrelationId,
  type DomainEventId,
  type EventSequence,
  type CommandOrigin,
  type CommandCause,
} from "./command-event-identifiers";

// Task 2: closed command and event name catalogues
export {
  patientSettingsCommandNameSchema,
  carePlanCommandNameSchema,
  healthRecordCommandNameSchema,
  patientControlCommandNameSchema,
  learningPatternCommandNameSchema,
  inquiryCommandNameSchema,
  safetyCommandNameSchema,
  carePreparationCommandNameSchema,
  commandNameSchema,
  patientSettingsEventNameSchema,
  carePlanEventNameSchema,
  healthRecordEventNameSchema,
  learningEventNameSchema,
  patternEventNameSchema,
  inquiryEventNameSchema,
  safetyEventNameSchema,
  carePreparationEventNameSchema,
  domainEventNameSchema,
  type PatientSettingsCommandName,
  type CarePlanCommandName,
  type HealthRecordCommandName,
  type PatientControlCommandName,
  type LearningPatternCommandName,
  type InquiryCommandName,
  type SafetyCommandName,
  type CarePreparationCommandName,
  type CommandName,
  type PatientSettingsEventName,
  type CarePlanEventName,
  type HealthRecordEventName,
  type LearningEventName,
  type PatternEventName,
  type InquiryEventName,
  type SafetyEventName,
  type CarePreparationEventName,
  type DomainEventName,
} from "./command-event-names";

// Task 3: typed command envelope and head expectations (Packet 4B)
export {
  recordHeadExpectationSchema,
  createCommandEnvelopeSchema,
  type RecordHeadExpectation,
  type CommandEnvelope,
} from "./command-envelope";

// Task 4: canonical JSON SHA-256 hashing (Packet 4C)
export {
  sha256DigestSchema,
  canonicalizeJson,
  hashCanonicalJson,
  hashCommandEnvelope,
  type Sha256Digest,
} from "./canonical-json";

// Task 4: command errors and receipts (Packet 4C)
export {
  COMMAND_ERROR_CODES,
  commandErrorCodeSchema,
  commandReceiptSchema,
  type CommandErrorCode,
  type CommandReceipt,
} from "./command-receipt";

// Packet 4D: immutable domain-event envelope (Section 3.2)
export {
  eventRecordChangeSchema,
  createDomainEventEnvelopeSchema,
  type EventRecordChange,
  type DomainEventEnvelope,
} from "./domain-event-envelope";

// Packet 4E: durable work contracts (Section 4.1)
export {
  workItemIdSchema,
  createWorkItemId,
  CONSUMER_KEYS,
  consumerKeySchema,
  WORK_PRIORITIES,
  workPrioritySchema,
  WORK_ERROR_CODES,
  workErrorCodeSchema,
  WORK_OBSOLETE_REASON_CODES,
  workObsoleteReasonCodeSchema,
  eventWorkStateSchema,
  eventWorkItemSchema,
  type WorkItemId,
  type ConsumerKey,
  type WorkPriority,
  type WorkErrorCode,
  type WorkObsoleteReasonCode,
  type EventWorkState,
  type EventWorkItem,
} from "./event-work";

// Packet 4E: consumer receipts (Section 4.2)
export {
  eventConsumerReceiptSchema,
  type EventConsumerReceipt,
} from "./event-consumer-receipt";
