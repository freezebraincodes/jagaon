import {
  intakeEventPayloadSchema,
  type IntakeEventPayload,
} from "../domain/health-records/intake-event";
import {
  symptomReportPayloadSchema,
  type SymptomReportPayload,
} from "../domain/health-records/symptom-report";
import {
  activityEventPayloadSchema,
  type ActivityEventPayload,
} from "../domain/health-records/activity-event";

// --- Section 5.9: Readonly synthetic fixture catalogue ---

// Representative valid examples for core logging observations. Invalid and
// boundary examples are kept in tests, not exported as demo fixtures.

const adHocSnack = intakeEventPayloadSchema.parse({
  intakeKind: "SNACK",
  occasion: "AD_HOC",
  foodIncluded: "YES",
  drinkIncluded: "NO",
  items: [{ kind: "FOOD", label: "Apple" }],
}) satisfies IntakeEventPayload;

const teaWithUnknownFood = intakeEventPayloadSchema.parse({
  intakeKind: "TEA",
  occasion: "ROUTINE",
  foodIncluded: "UNKNOWN",
  drinkIncluded: "YES",
  items: [{ kind: "DRINK", label: "Tea" }],
}) satisfies IntakeEventPayload;

const teaWithoutFood = intakeEventPayloadSchema.parse({
  intakeKind: "TEA",
  occasion: "ROUTINE",
  foodIncluded: "NO",
  drinkIncluded: "YES",
  items: [{ kind: "DRINK", label: "A cup of tea only" }],
}) satisfies IntakeEventPayload;

const teaWithFood = intakeEventPayloadSchema.parse({
  intakeKind: "TEA",
  occasion: "ROUTINE",
  foodIncluded: "YES",
  drinkIncluded: "YES",
  items: [
    { kind: "DRINK", label: "Tea" },
    { kind: "FOOD", label: "Biscuits" },
  ],
}) satisfies IntakeEventPayload;

const presentEmergencySymptom = symptomReportPayloadSchema.parse({
  reportKind: "PRESENT",
  symptoms: [{ code: "SEIZURE", severity: "SEVERE" }],
}) satisfies SymptomReportPayload;

const chairYoga = activityEventPayloadSchema.parse({
  activityCategory: "FLEXIBILITY_OR_MOBILITY",
  patientLabel: "Chair yoga",
}) satisfies ActivityEventPayload;

export const coreLoggingObservations = Object.freeze({
  adHocSnack,
  teaWithUnknownFood,
  teaWithoutFood,
  teaWithFood,
  presentEmergencySymptom,
  chairYoga,
});