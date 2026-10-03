// Public barrel for the Packet 7A Pattern domain contracts.

export {
  PATTERN_FAMILIES,
  patternFamilySchema,
  PATTERN_LIFECYCLE_STATES,
  PATTERN_EVIDENCE_GROUP_ROLES,
  PATTERN_EXCLUSION_REASONS,
  PATTERN_LIMITATION_CODES,
  PATTERN_GATE_DIMENSIONS,
  PATTERN_GATE_REGISTRY,
  PATTERN_FAMILY_GROUP_ROLES,
  aggregatePatternGate,
  type PatternFamily,
  type PatternLifecycleState,
  type PatternEvidenceGroupRole,
  type PatternExclusionReason,
  type PatternLimitationCode,
  type PatternGateDimension,
  type PatternGateOutcome,
  type PatternGateOverall,
} from "./pattern-registry";

export {
  ELIGIBLE_PATIENT_SELECTED_SLOTS,
  comparableGlucoseSlotSchema,
  patternComparableSubjectSchema,
  type ComparableGlucoseSlot,
  type EligiblePatientSelectedSlot,
} from "./pattern-comparable";

export {
  patternClaimSchema,
  CROSS_VARIABLE_ASSOCIATION_DEFINITIONS,
  type PatternClaim,
  type ComparableSlotTrendClaim,
  type FamiliarOrFrequentItemClaim,
} from "./pattern-claims";

export {
  patternFamilyEvidenceFactsSchema,
  type PatternFamilyEvidenceFacts,
  type ComparableSlotTrendEvidenceFacts,
  type FamiliarOrFrequentItemEvidenceFacts,
  type FamiliarItemEvidenceMatch,
  type ComparableGlucoseReadingAssignment,
} from "./pattern-facts";

export {
  PATTERN_RECORD_DELETION_POLICY,
  PATTERN_OBSERVATION_REVISION_ACTIONS,
  PATTERN_EVIDENCE_SNAPSHOT_REVISION_ACTIONS,
  patternLifecycleSchema,
  patternPatientDispositionSchema,
  patternObservationPayloadSchema,
  patternEvidenceSnapshotPayloadSchema,
  patternObservationRevisionSchema,
  patternEvidenceSnapshotRevisionSchema,
  validatePatternPair,
  type PatternLifecycle,
  type PatternObservationPayload,
  type PatternEvidenceSnapshotPayload,
  type PatternObservationRevision,
  type PatternEvidenceSnapshotRevision,
  type PatternPairValidation,
} from "./pattern-records";

export {
  compareDecimalStrings,
  decimalSign,
  formatRatioHalfUp,
  isCanonicalDecimal,
  stableStringify,
} from "./pattern-decimal";
