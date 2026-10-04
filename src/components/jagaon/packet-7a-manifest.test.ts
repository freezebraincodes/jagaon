import { describe, expect, it } from "vitest";
import * as learning from "@/domain/learning";
import * as patterns from "@/domain/patterns";
import { REVERSE_DEPENDENCY_EVALUATORS } from "@/storage/reverse-dependency-row";
import { JAGAON_DEXIE_VERSION, JAGAON_TABLE_NAMES } from "@/storage/table-catalogue";
import {
  INTELLIGENCE_ACTIVATION_MANIFEST,
  enabledLearningFamilies,
  enabledPatternFamilies,
} from "@/application/intelligence/activation-manifest";
import { INTELLIGENCE_SUBSCRIPTIONS } from "@/application/intelligence/intelligence-subscriptions";
import { HISTORY_PERIODS } from "@/application/history/recorded-history-contracts";
import { getMessages } from "@/i18n/get-messages";
import { ALL_SCREENS, TOP_LEVEL_SCREENS } from "./screen-manifest";

describe("Packet 7A public exports and manifests", () => {
  it("exports exactly the approved Learning domain symbols", () => {
    expect(Object.keys(learning).sort()).toEqual(
      [
        "DAYS_OF_WEEK",
        "LEARNED_KNOWLEDGE_DELETION_POLICY",
        "LEARNED_KNOWLEDGE_LIFECYCLE_STATES",
        "LEARNED_KNOWLEDGE_REVISION_ACTIONS",
        "LEARNING_FAMILIES",
        "activityFamiliarItemIdentitySchema",
        "anyTypedRevisionRefSchema",
        "atemporalSchema",
        "barrierAffectedTaskSchema",
        "dayOfWeekSchema",
        "familiarItemIdentitySchema",
        "familiarItemKeySchema",
        "hasDuplicateRefs",
        "ianaTimeZoneIdSchema",
        "intakeFamiliarItemIdentitySchema",
        "learnedBarrierIdentitySchema",
        "learnedKnowledgeActivationSchema",
        "learnedKnowledgeContentSchema",
        "learnedKnowledgeEvidenceSchema",
        "learnedKnowledgeLifecycleSchema",
        "learnedKnowledgePayloadSchema",
        "learnedKnowledgeRevisionSchema",
        "learnedRoutinePatternSchema",
        "learnedRoutineSubjectSchema",
        "learnedScopeSchema",
        "learningFamilySchema",
        "localTimeWindowFields",
        "localTimeWindowIssue",
        "patientBarrierKeySchema",
        "patientDefinedContextKeySchema",
        "revisionRefKey",
        "uniqueDaySetSchema",
        "uniqueRefListSchema",
        "uniqueRefTupleSchema",
        "versionIdentifierSchema",
      ].sort(),
    );
  });

  it("exports exactly the approved Pattern domain symbols", () => {
    expect(Object.keys(patterns).sort()).toEqual(
      [
        "CROSS_VARIABLE_ASSOCIATION_DEFINITIONS",
        "ELIGIBLE_PATIENT_SELECTED_SLOTS",
        "PATTERN_EVIDENCE_GROUP_ROLES",
        "PATTERN_EVIDENCE_SNAPSHOT_REVISION_ACTIONS",
        "PATTERN_EXCLUSION_REASONS",
        "PATTERN_FAMILIES",
        "PATTERN_FAMILY_GROUP_ROLES",
        "PATTERN_GATE_DIMENSIONS",
        "PATTERN_GATE_REGISTRY",
        "PATTERN_LIFECYCLE_STATES",
        "PATTERN_LIMITATION_CODES",
        "PATTERN_OBSERVATION_REVISION_ACTIONS",
        "PATTERN_RECORD_DELETION_POLICY",
        "aggregatePatternGate",
        "comparableGlucoseSlotSchema",
        "compareDecimalStrings",
        "decimalSign",
        "formatRatioHalfUp",
        "isCanonicalDecimal",
        "patternClaimSchema",
        "patternComparableSubjectSchema",
        "patternEvidenceSnapshotPayloadSchema",
        "patternEvidenceSnapshotRevisionSchema",
        "patternFamilyEvidenceFactsSchema",
        "patternFamilySchema",
        "patternLifecycleSchema",
        "patternObservationPayloadSchema",
        "patternObservationRevisionSchema",
        "patternPatientDispositionSchema",
        "stableStringify",
        "validatePatternPair",
      ].sort(),
    );
  });

  it("registers storage edges only for enabled evaluators at their manifest versions", () => {
    const enabled = [
      ...Object.values(INTELLIGENCE_ACTIVATION_MANIFEST.pattern),
      ...Object.values(INTELLIGENCE_ACTIVATION_MANIFEST.learning),
    ].flatMap((disposition) => (disposition.kind === "ENABLED" ? [[disposition.evaluatorKey, disposition.evaluatorVersion]] : []));
    const intelligenceEdges = Object.entries(REVERSE_DEPENDENCY_EVALUATORS).filter(
      ([, value]) => value.owner === "PATTERN_ENGINE" || value.owner === "LEARNING_ENGINE",
    );
    expect(intelligenceEdges.map(([key, value]) => [key, value.versions[0]]).sort()).toEqual(enabled.sort());
  });

  it("gates every reviewed Evidence Gate version to an enabled family", () => {
    const gateFamilies = Object.values(patterns.PATTERN_GATE_REGISTRY).map((entry) => entry.family).sort();
    expect(gateFamilies).toEqual([...enabledPatternFamilies()].sort());
    expect(enabledLearningFamilies()).toEqual(["FAMILIAR_ITEM"]);
  });

  it("subscribes ordinary intelligence only to health-record events, never to derived events", () => {
    for (const subscription of INTELLIGENCE_SUBSCRIPTIONS) {
      expect(subscription.eventName).not.toMatch(/^(PATTERN|LEARNED|INQUIRY|SAFETY|CARE_SUMMARY)/);
      expect(subscription.priority).toBe("ORDINARY_INTELLIGENCE");
    }
  });

  it("keeps the 16-table storage catalogue and the closed screen manifest", () => {
    expect(JAGAON_TABLE_NAMES).toHaveLength(16);
    expect(JAGAON_DEXIE_VERSION).toBe(1);
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "MEDICATION_SCHEDULE", "HISTORY", "MORE"]);
    // Packet 9B adds PREVENTIVE_CARE and CARE_PREPARATION; 9C adds CARE_SUMMARY_PREVIEW.
    expect(ALL_SCREENS.size).toBe(17);
    expect(HISTORY_PERIODS).toEqual(["THIS_WEEK", "LAST_WEEK", "THIRTY_DAYS"]);
  });

  it("ships every 07a copy-matrix row and typed label in both locales", () => {
    const keys = Object.keys(getMessages("en-SG").history).sort();
    expect(keys).toHaveLength(54);
    expect(Object.keys(getMessages("zh-SG").history).sort()).toEqual(keys);
  });
});
