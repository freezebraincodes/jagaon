// Public barrel for patient-settings domain modules.

export {
  SUPPORTED_LOCALES,
  supportedLocaleSchema,
  type SupportedLocale,
} from "./locale";

export {
  patientProfilePayloadSchema,
  type PatientProfilePayload,
} from "./profile";

export {
  patientPreferencePayloadSchema,
  DEFAULT_GLUCOSE_DISPLAY_UNIT,
  type PatientPreferencePayload,
} from "./preferences";

export {
  conditionPayloadSchema,
  conditionKnowledgeClassSchema,
  CONDITION_KNOWLEDGE_CLASS,
  type ConditionPayload,
} from "./condition";

export {
  validateSingleActiveProfile,
  validateOneActivePreferencePerKind,
  type PreferenceHead,
} from "./invariants";