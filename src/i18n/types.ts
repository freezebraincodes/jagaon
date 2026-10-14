export type { SupportedLocale } from "../domain/patient-settings/locale";
import type { Packet10Messages } from "./packet10-types";
import type { NoteThemeKey } from "../domain/notes/note-themes";
export type { Packet10Messages } from "./packet10-types";

// ---------------------------------------------------------------------------
// Packet 6 bilingual message catalogue
//
// Every key corresponds to an APPROVED_UI row in
// internal-docs/implementation-plans/06-bilingual-copy-matrix.md.
// Parameterised messages use typed functions so units, numbers, dates, and
// source names remain data rather than string fragments.
// ---------------------------------------------------------------------------

/** Text parameter for messages that interpolate a reviewed date. */
export type LocalDateText = string;

/** Text parameter for messages that interpolate a local time. */
export type LocalTimeText = string;

/** Shared shell and control messages. */
export type SharedMessages = {
  appName: string;
  demoBoundary: string;
  navToday: string;
  navMore: string;
  back: string;
  close: string;
  cancel: string;
  save: string;
  saving: string;
  retry: string;
  edit: string;
  continue: string;
  loading: string;
  optional: string;
  source: string;
  reviewedOn: (date: LocalDateText) => string;
  recordedAt: (time: LocalTimeText) => string;
  notSaved: string;
  storageUnavailable: string;
  requiredField: string;
  invalidValue: string;
  // Packet 6 v1 convergence (needs bilingual review)
  navBooklet: string;
  navHistory: string;
  unavailable: string;
  minutes: (count: number) => string;
  todayAt: (time: LocalTimeText) => string;
  yesterdayAt: (time: LocalTimeText) => string;
  nowAt: (time: LocalTimeText) => string;
};

/** Today dashboard messages (frame 01). */
export type TodayMessages = {
  title: string;
  greeting: (displayName: string) => string;
  subtitle: string;
  logReading: string;
  recordReading: string;
  recordInsulin: string;
  logMeal: string;
  latestEntries: string;
  summaryTiles: string;
  latestRecordedReading: string;
  noEntries: string;
  todayBooklet: string;
  bookletProgress: (completed: number, total: number) => string;
  slotMorning: string;
  slotAfternoon: string;
  slotEvening: string;
  viewHistory: string;
  viewMedicationInfo: string;
  nearbyFood: string;
  insulinToday: string;
  scheduled: string;
  intakeRecord: string;
  notRecorded: string;
  addRecord: string;
  mealTitle: string;
  activityTitle: string;
  carePlanning: string;
  futureFeature: string;
  // Packet 6 v1 convergence (needs bilingual review)
  careDatesHeading: string;
  careDatesNote: string;
  prepareAppointment: string;
  enteredByYou: string;
  // Packet 6A frame 31 (needs bilingual review)
  medicinesToday: string;
  noMedicinesTitle: string;
  noMedicinesNotMissed: string;
  noMedicinesNote: string;
  greetingNoName: string;
  /** Finding T-1: the measurement/event time was not given (shown only for an UNKNOWN occurrence, never as missing or missed). */
  timeNotRecorded: string;
  /** Finding T-1: the recording timestamp (recordedAt), labelled as such; never presented as the measurement/event time. */
  enteredAt: (time: string) => string;
};

/** Glucose entry and time-correction messages (frames 02–03). */
export type GlucoseMessages = {
  title: string;
  valueLabel: string;
  unit: string;
  methodLabel: string;
  methodFingerstick: string;
  methodCgm: string;
  methodFlash: string;
  methodOther: string;
  methodUnknown: string;
  contextLabel: string;
  contextFasting: string;
  contextBeforeMeal: string;
  contextAfterMeal: string;
  contextBedtime: string;
  contextUnspecified: string;
  occurrenceTime: string;
  noteLabel: string;
  saveAction: string;
  saved: string;
  invalidDecimal: string;
  noInterpretation: string;
  // Packet 6 v1 convergence (needs bilingual review)
  whenQuestion: string;
  contextBeforeBreakfast: string;
  contextBeforeLunch: string;
  contextBeforeDinner: string;
  contextJustChecking: string;
  keypadLabel: string;
  deleteDigit: string;
  decimalPoint: string;
  timeNowHint: string;
  storedAs: (context: string, when: string) => string;
  moreDetails: string;
  /**
   * CR-11 (owner decisions 2026-10-11, design v3.1; R-3): the manual number-and-unit confirmation step. `confirmBody` is sentences 1–2
   * of the approved verification copy, verbatim; the control labels are the approved EN labels and the R-3 ZH labels.
   */
  confirmBody: string;
  saveAsShown: string;
  editReading: string;
  cancelConfirm: string;
  /** CR-11: typed or pasted text that is not digits with at most one decimal digit is refused (never trimmed). Wording owner-approved 2026-10-11. */
  formatRefused: string;
};

export type ReadingTimeMessages = {
  title: string;
  current: string;
  newDate: string;
  newTime: string;
  saveAction: string;
  saved: string;
  editTime: string;
  // Packet 6 v1 convergence (needs bilingual review)
  whichDay: string;
  dayToday: string;
  dayYesterday: string;
  dayOther: string;
  whatTime: string;
  hourLabel: string;
  minuteLabel: string;
  periodLabel: string;
  am: string;
  pm: string;
  wheelHint: string;
  typeInstead: string;
  recordedFor: (reading: string, when: string) => string;
  sameAsCurrent: string;
  currentlyRecorded: (when: string) => string;
  historyNote: string;
  saveOccurrence: string;
  useNow: string;
  /** Refusal when the chosen occurrence time is later than now. */
  laterThanNow: string;
};

/** Insulin occurrence and meal entry messages (frames 04–05). */
export type InsulinMessages = {
  title: string;
  recordOnly: string;
  medicineLabel: string;
  recordedDirection: string;
  amountLabel: string;
  unit: string;
  timeLabel: string;
  noteLabel: string;
  saveAction: string;
  saved: string;
  // Packet 6 v1 convergence (needs bilingual review)
  subtitle: string;
  scheduledInfo: string;
  prescriptionSchedule: string;
  whatRecording: string;
  notEnteredYet: string;
  decreaseUnits: string;
  increaseUnits: string;
  correctionHistory: string;
  correctionHistoryBody: string;
  enterUnitsToSave: string;
};

export type MealMessages = {
  title: string;
  typeLabel: string;
  breakfast: string;
  lunch: string;
  dinner: string;
  supper: string;
  other: string;
  timeLabel: string;
  itemLabel: string;
  quantityLabel: string;
  addItem: string;
  removeItem: (itemLabel: string) => string;
  noteLabel: string;
  saveAction: string;
  saved: string;
  noNutritionInference: string;
  // Packet 6 v1 convergence (needs bilingual review)
  screenTitle: string;
  subtitle: string;
  whatWasIt: string;
  kindMeal: string;
  kindSnack: string;
  kindTea: string;
  kindTeaWithFood: string;
  kindTeaWithoutFood: string;
  kindDessert: string;
  kindDrink: string;
  kindNotSure: string;
  usualsHeading: string;
  somethingElse: string;
  portionLabel: string;
  portionSmall: string;
  portionUsual: string;
  portionBig: string;
  portionNote: (portion: string) => string;
  saveIntake: string;
  chooseToSave: string;
};

/** Medication understanding messages (frame 08). */
export type MedicationMessages = {
  title: string;
  generalHeading: string;
  recordedHeading: string;
  glarginePurpose: string;
  glargineUse: string;
  glulisinePurpose: string;
  glulisineUse: string;
  generalLimit: string;
  recordedVerbatim: string;
  askHeading: string;
  askPurpose: string;
  askDirections: string;
  infoUnavailable: string;
  // Packet 6 v1 convergence (needs bilingual review)
  screenTitle: string;
  aboutThisMedicine: string;
  notPersonalised: string;
  reviewedTag: string;
  recordedTag: string;
  actionsTag: string;
  fieldForm: string;
  fieldAmount: string;
  fieldTiming: string;
  fieldEffective: string;
  fieldProvenance: string;
  fieldDirections: string;
  provenanceUser: string;
  provenanceDocument: string;
  sampleQuestionLabel: string;
  addQuestion: string;
  sourceHistory: string;
};

/** Nearby food and general food information messages (frame 07 + 12 states). */
export type FoodMessages = {
  title: string;
  subtitle: string;
  locationLabel: string;
  locationPlaceholder: string;
  searchAction: string;
  useCurrentLocation: string;
  prePermissionTitle: string;
  prePermissionBody: string;
  usePostalInstead: string;
  locating: string;
  viewMap: string;
  viewList: string;
  distanceLabel: string;
  cuisineLabel: string;
  resultsCount: (count: number) => string;
  syntheticMapAttribution: string;
  syntheticDirectorySource: string;
  permissionDeniedTitle: string;
  permissionDeniedBody: string;
  ambiguousTitle: string;
  ambiguousBody: (query: string) => string;
  noResultsTitle: string;
  noResultsBody: string;
  mapUnavailableTitle: string;
  mapUnavailableBody: string;
  directoryUnavailableTitle: string;
  directoryUnavailableBody: string;
  offlineTitle: string;
  offlineBody: (date: LocalDateText) => string;
  detailsTitle: string;
  openDirections: string;
  directionsUnavailable: string;
  generalInfoAction: string;
  generalInfoTitle: string;
  generalInfoLimit: string;
  reviewedInfoUnavailable: string;
  // Packet 6 v1 convergence (needs bilingual review)
  locationNote: string;
  filtersHeading: string;
  resetFilters: string;
  within: (distance: string) => string;
  cuisineAny: string;
  cuisineChinese: string;
  cuisineMalay: string;
  cuisineIndian: string;
  cuisineWestern: string;
  venueTypeLabel: string;
  venueHawker: string;
  venueCoffeeShop: string;
  venueMarket: string;
  venueFoodCourt: string;
  attributesLabel: string;
  hpbWording: string;
  attrWholegrains: string;
  attrLowerSugar: string;
  attrLowerCalories: string;
  attributesNote: string;
  sortedByDistance: string;
  legendProvider: string;
  legendGoverned: string;
  providerFacts: string;
  noGovernedAttribute: string;
  checkAvailability: string;
  viewDetails: string;
  aboutDistance: (distance: string) => string;
  youAreHere: string;
  // Packet 9A additions (09-bilingual-copy-matrix.md Section 1)
  locationNotSaved: string;
  liveMapLoading: string;
  oneMapAttribution: string;
  oneMapPrivacy: string;
  liveGeocoderUnavailable: string;
  mapTilesUnavailable: string;
  governedDatasetSource: string;
  governedDatasetDate: (date: LocalDateText) => string;
  governedDatasetStale: string;
  syntheticFallbackActive: string;
  locationTimedOut: string;
  locationUnavailable: string;
};

/** More, settings, reset, and generic help messages (frames 12–13). */
export type MoreMessages = {
  title: string;
  informationHeading: string;
  settingsHeading: string;
  medicationInfo: string;
  foodInfo: string;
  helpInfo: string;
  // Packet 6 v1 convergence (needs bilingual review)
  healthChecks: string;
  prepareVisit: string;
  reminders: string;
  foodInformation: string;
  foodInformationBody: string;
  helpBody: string;
  exportApps: string;
  exportBody: string;
  textSize: string;
  smallerText: string;
  largerText: string;
  textSizeSample: string;
  extraContrast: string;
  extraContrastBody: string;
  off: string;
  units: string;
  unitsBody: string;
  aboutDemo: string;
  syntheticTitle: string;
  syntheticBody: string;
  storageTitle: string;
  storageBody: string;
  boundaryTitle: string;
  boundaryBody: string;
};

export type SettingsMessages = {
  language: string;
  english: string;
  chinese: string;
  languageSaved: string;
  dataHeading: string;
  resetAction: string;
  resetTitle: string;
  resetBody: string;
  resetConfirm: string;
  resetDone: string;
};

export type HelpMessages = {
  title: string;
  noAssessment: string;
  emergencyHeading: string;
  call995: string;
  nonEmergencyHeading: string;
  nurseFirst: string;
  accessibleEmergency: string;
  verifyCurrent: string;
  // Packet 6 v1 convergence (needs bilingual review)
  generalContacts: string;
  publicInfoUnavailable: string;
  /** Owner decision 2026-10-14 (distress safety): emotional support contacts. English owner-approved; Chinese drafts. */
  emotionalSupportHeading: string;
  sosCall: string;
  sosWhatsApp: string;
  sosProvider: string;
  sosHours: string;
  mindlineCall: string;
  mindlineWhatsApp: string;
  mindlineProvider: string;
  mindlineHours: string;
  emotionalSupportVerify: string;
  sosWebsite: string;
  mindlineWebsite: string;
};

/** Packet 6A synthetic onboarding (frames 14–31; needs bilingual review). */
export type OnboardingMessages = {
  compactBoundary: string;
  progressLabel: string;
  stepOf: (step: number, total: number) => string;
  welcomeTitle: string;
  welcomeBody: string;
  languageLabel: string;
  startSetup: string;
  usePrepared: string;
  deviceNote: string;
  profileTitle: string;
  preferredNameLabel: string;
  preferredNamePlaceholder: string;
  preferredNameHint: string;
  noSensitiveData: string;
  skipForNow: string;
  medicinesTitle: string;
  medicinesIntro: string;
  recordedDirectionsLabel: string;
  editNamed: (name: string) => string;
  remove: string;
  removeNamed: (name: string) => string;
  addAnother: string;
  emptyTitle: string;
  emptyBody: string;
  addMedicine: string;
  skipMedicines: string;
  skipMedicinesNote: string;
  selectTitle: string;
  medicineNameLabel: string;
  searchPlaceholder: string;
  catalogueHeading: string;
  brandWithGeneric: (generic: string) => string;
  genericNoBrand: string;
  formPen: string;
  formTablet: string;
  reviewedAvailable: string;
  reviewedUnavailableTag: string;
  notListedTitle: string;
  notListedBody: string;
  recordedExactly: string;
  noReviewedForEntered: string;
  catalogueDisclaimer: string;
  nameRequired: string;
  directionsTitle: string;
  yourRecordTag: string;
  recordedPrescriptionTitle: string;
  allOptional: string;
  unknownLegend: string;
  fieldStrength: string;
  fieldAmount: string;
  fieldSchedule: string;
  fieldDirections: string;
  directionsPlaceholder: string;
  iDontKnow: string;
  iDontKnowNamed: (field: string) => string;
  /** Separator after an inline fact label (': ' or full-width '：'). */
  labelSeparator: string;
  enterValue: string;
  sourceLabel: string;
  sourcePrescriptionLabel: string;
  sourceCareTeam: string;
  sourcePatient: string;
  sourceUnknown: string;
  purposeLabel: string;
  useLabel: string;
  neverRewrites: string;
  reviewedUnavailableBody: string;
  saveRecorded: string;
  reviewTitle: string;
  aboutYou: string;
  notProvided: string;
  recordedMedicines: string;
  recordedSchedule: string;
  unknownValue: string;
  unknownLater: string;
  notMissed: string;
  finishSetup: string;
  completeTitle: string;
  completeBody: string;
  recordedHeading: string;
  medicineCount: (count: number) => string;
  noMedicinesRecorded: string;
  openToday: string;
  reviewMedicines: string;
  resumeTitle: string;
  resumeBody: (step: number, stepLabel: string) => string;
  stepProfile: string;
  stepMedicines: string;
  stepAddMedicine: string;
  stepDirections: string;
  stepReview: string;
  kept: string;
  notYetSaved: string;
  continueAtStep: (work: string, step: number) => string;
  directionsFor: (name: string) => string;
  nothingSavedYet: string;
  continueFromStep: (step: number) => string;
  startAgain: string;
  startAgainNote: string;
  restartTitle: string;
  restartBody: (saved: string) => string;
  restartNothingSaved: string;
  restartSavedName: string;
  restartNoReal: string;
  keepProgress: string;
  confirmRestart: string;
  removeTitle: string;
  removeBody: (name: string) => string;
  keepIt: string;
  removeMedicine: string;
  skippedTitle: string;
  skippedBody: string;
  addMedicineNow: string;
  failureTitle: string;
  failureBody: string;
  failureStatus: string;
  tryAgain: string;
  returnWelcome: string;
  returnDiscards: string;
  noCloud: string;
  languageSwitched: (language: string) => string;
  notTranslated: string;
  savedAnnouncement: string;
  resumedAnnouncement: string;
  medicineInformationLink: string;
};

/** The complete typed bilingual application message catalogue. */
/**
 * Packet 7A Recorded history (07a copy matrix). Parameters are identical in
 * both locales; patient-entered labels are passed through verbatim.
 */
export type HistoryMessages = {
  title: string;
  periodThisWeek: string;
  periodLastWeek: string;
  periodThirtyDays: string;
  loading: string;
  unavailableTitle: string;
  unavailableBody: string;
  retry: string;
  emptyTitle: string;
  emptyBody: string;
  insufficientTitle: string;
  insufficientBody: string;
  readingsTitle: (unit: string) => string;
  recordedLegend: string;
  notRecordedLegend: string;
  chartDescription: (recorded: number, positions: number, unit: string) => string;
  chartSlotsNote: string;
  recordedDataTag: string;
  factsTitle: string;
  periodRange: (range: string) => string;
  readingCount: (count: number, range: string) => string;
  valueRange: (minimum: string, maximum: string, unit: string) => string;
  slotCount: (slot: string, count: number) => string;
  comparisonHigher: (slot: string, recent: string, reference: string, unit: string) => string;
  comparisonLower: (slot: string, recent: string, reference: string, unit: string) => string;
  comparisonVariability: (slot: string, recent: string, reference: string, unit: string) => string;
  noMaterialComparison: (slot: string) => string;
  repeatedItem: (label: string, count: number, days: number) => string;
  repeatedContext: (label: string, count: number, days: number) => string;
  notRecordedPosition: (position: string) => string;
  notRecordedPositions: (positions: string) => string;
  sourceSummary: (source: string) => string;
  sourcePatientEntered: string;
  correctionSummary: (count: number) => string;
  correctionUpdated: string;
  evidenceWindow: (recent: string, reference: string) => string;
  nonCausalLimitation: string;
  loggingLimitation: string;
  bookletTitle: string;
  bookletOnly: string;
  bookletExplanation: string;
  completeStamp: (date: string) => string;
  incompleteStamp: (date: string, count: number) => string;
  actionsTag: string;
  addFacts: string;
  selectFacts: string;
  factSelected: string;
  factNotSelected: string;
  selectionSaved: string;
  familyUnavailable: string;
  disabledFamily: (family: string) => string;
  slotLabels: Record<"BEFORE_BREAKFAST" | "BEFORE_LUNCH" | "BEFORE_DINNER" | "BEDTIME", string>;
  positionLabels: Record<"MORNING" | "EVENING", string>;
  periodLabels: Record<"THIS_WEEK" | "LAST_WEEK" | "THIRTY_DAYS", string>;
  /** Packet 11C Task 7: the explanation panel under an explainable comparison (new application copy; the 7A rows above are unchanged). */
  explanation: HistoryExplanationMessages;
};

/**
 * Packet 11C Task 7 explanation-panel copy, history-explanation.11c.2 (Packet 11C B4a: `supportingHeading` reworded, `singaporeTime` and
 * `offsetReading` added; every B4a string is human acceptance pending). `start`, `cutoff` and `end` are Singapore-time points
 * (`singaporeTime`) derived from the view's own period instants; counts are the view's included readings.
 */
export type HistoryExplanationMessages = {
  action: string;
  /** The panel heading (focus target on open). */
  title: string;
  aiLabel: string;
  /** Owner decision 3: "the readings included in this comparison" (the evaluator's included readings; excluded duplicates never added). */
  supportingHeading: (count: number) => string;
  /** Owner decision 2: a point in Singapore time, from a "date" and an "HH:MM" (or "HH:MM:SS") string. */
  singaporeTime: (date: string, time: string) => string;
  /**
   * D7: a reading recorded at an offset other than +08:00: its recorded local "date, time", its actual offset label (e.g. "UTC+05:30")
   * and its exact Singapore-time equivalent (`singaporeTime`, computed from the source instant).
   */
  offsetReading: (recorded: string, offset: string, singapore: string) => string;
  periodHeading: (role: "EARLIER" | "RECENT", count: number) => string;
  reconciliation: (earlier: number, recent: number, total: number) => string;
  unavailable: string;
  stale: string;
  earlierRange: (start: string, cutoff: string) => string;
  recentRange: (cutoff: string, end: string) => string;
  boundaryNote: (cutoff: string) => string;
};

/**
 * Packet 8 Medication schedule copy (08-bilingual-copy-matrix.md). Keys mirror
 * the matrix rows; the "Packet 8 rendering additions" below are the minimal
 * extra strings needed to render the approved states and are reported as such.
 */
export type ScheduleMessages = {
  title: string;
  demoBoundary: string;
  back: string;
  loading: string;
  unavailableTitle: string;
  unavailableBody: string;
  retry: string;
  emptyTitle: string;
  emptyBody: string;
  notAdvice: string;
  sectionYesterday: (date: LocalDateText) => string;
  sectionToday: (date: LocalDateText) => string;
  scheduled: string;
  intakeRecord: string;
  notRecorded: string;
  recordedTaken: string;
  recordedSkipped: string;
  recordedNotSure: string;
  recordedDeclined: string;
  recordedAt: (time: LocalTimeText) => string;
  amountRecorded: (amount: string, unit: string) => string;
  amountNotRecorded: string;
  sourcePatient: (date: LocalDateText) => string;
  sourceDocument: (date: LocalDateText) => string;
  sourceFixture: (date: LocalDateText) => string;
  missingMeaning: string;
  addRecord: string;
  changeRecord: string;
  recordTitle: string;
  recordOccasion: (medicine: string, date: LocalDateText, time: LocalTimeText) => string;
  optionTaken: string;
  optionSkipped: string;
  optionNotSure: string;
  optionDecline: string;
  amountHeading: string;
  amountKnown: string;
  amountUnknown: string;
  amountOmitted: string;
  noDoseAdvice: string;
  saveRecord: string;
  cancelRecord: string;
  saved: string;
  saveFailedTitle: string;
  saveFailedBody: string;
  trySavingAgain: string;
  barrierOfferTitle: string;
  barrierWhy: (status: string, medicine: string, date: LocalDateText) => string;
  barrierQuestion: string;
  barrierForgot: string;
  barrierRoutineChanged: string;
  barrierAway: string;
  barrierAccess: string;
  barrierSideEffectConcern: string;
  barrierSomethingElse: string;
  barrierNotSure: string;
  barrierPreferNot: string;
  barrierSave: string;
  barrierSkip: string;
  barrierLater: string;
  barrierSaved: string;
  barrierSaveFailed: string;
  barrierRemove: string;
  barrierCorrect: string;
  recordedDataBadge: string;
  whatRecorded: (startDate: LocalDateText, endDate: LocalDateText) => string;
  countIntro: string;
  countOne: (label: string) => string;
  countMany: (label: string, count: number) => string;
  countEvidence: (occasions: string) => string;
  noBarrierCounts: string;
  unrecordedCountOne: string;
  unrecordedCountMany: (count: number) => string;
  countLimitation: string;
  countMeaning: string;
  actionsBadge: string;
  changeReminderSettings: string;
  addRoutineNote: string;
  addProfessionalQuestion: string;
  questionTitle: string;
  questionHelp: string;
  questionSave: string;
  questionSaved: string;
  remindersHeading: string;
  reminderOn: string;
  reminderOff: string;
  reminderReview: string;
  reminderReviewBody: string;
  reminderConfirmTitle: string;
  reminderConfirmBody: string;
  reminderConfirm: string;
  reminderCancel: string;
  reminderSaved: string;
  reminderFailed: string;
  reminderLimitation: string;
  inAppOnly: string;
  // --- Packet 8 rendering additions (not in the copy matrix; reported) ---
  amountInputLabel: (unit: string) => string;
  amountRequired: string;
  stateRequired: string;
  unitLabels: Record<"MCG" | "MG" | "G" | "ML" | "UNIT" | "TABLET" | "CAPSULE" | "PUFF" | "DROP" | "PATCH", string>;
  noFixedTimeFor: (medicine: string) => string;
  somethingElseLabel: string;
  somethingElseRequired: string;
  answerRecordedAs: (label: string) => string;
  countExcluded: (count: number) => string;
  reminderTimeLabel: string;
  reminderDaily: (time: LocalTimeText) => string;
  reminderOnDays: (days: string, time: LocalTimeText) => string;
  reminderReviewAction: string;
  reminderToggleLabel: (label: string) => string;
  dayNames: Record<"MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", string>;
  questionEdit: string;
  questionRemove: string;
  questionRequired: string;
  barrierAnswerHeading: string;
};

/** Packet 9B Screen 09 copy (09-bilingual-copy-matrix.md Section 2 plus primary frame 09). */
export type PreventiveCareMessages = {
  title: string;
  maintainedByYou: string;
  statusScheduled: string;
  statusRecorded: string;
  statusNoDate: string;
  dateEntered: string;
  note: string;
  source: string;
  markRecorded: string;
  undoRecorded: string;
  edit: string;
  history: string;
  addItem: string;
  recordLimitation: string;
  generalHeading: string;
  reviewedTag: string;
  generalIntro: string;
  generalNotAssessment: string;
  emptyTitle: string;
  emptyBody: string;
  saveFailed: string;
  // Primary-frame 09 wording (approved through the v1 frame)
  topicEyeTitle: string;
  topicEyeKind: string;
  topicVaccinationTitle: string;
  topicVaccinationKind: string;
  topicLifestyleTitle: string;
  topicLifestyleKind: string;
  topicFollowUpTitle: string;
  topicFollowUpKind: string;
  // --- Packet 9B rendering additions (not in the matrix; reported for review) ---
  itemNameLabel: string;
  loading: string;
  unavailableTitle: string;
  historyEntered: string;
  historyCorrected: string;
  historyChanged: string;
  historyRecorded: string;
  historyRecordCorrected: string;
  dateNotKnown: string;
  saved: string;
};

/** Packet 9B Screen 10 copy (09-bilingual-copy-matrix.md Section 3 plus primary frame 10). */
export type CarePreparationMessages = {
  title: string;
  appointmentEnteredByYou: string;
  appointmentUnverified: string;
  actionsTag: string;
  includeHeading: string;
  glucoseReadings: string;
  insulinRecords: string;
  mealNotes: string;
  walks: string;
  questionsHeading: string;
  questionsIntro: string;
  medicineInfoQuestions: string;
  directionsQuestions: string;
  routineQuestions: string;
  trendQuestions: string;
  preventiveQuestions: string;
  noneSelected: string;
  addOwnQuestion: string;
  questionLabel: string;
  questionHint: string;
  selectionLimitation: string;
  previewSummary: string;
  exportOrPrint: string;
  localOnly: string;
  emptySelection: string;
  saveFailed: string;
  // Primary-frame 10 wording (approved through the v1 frame)
  inDays: (count: number) => string;
  glucoseDetail: (startDate: LocalDateText, endDate: LocalDateText, count: number) => string;
  insulinDetail: string;
  mealDetail: string;
  walkDetail: string;
  // --- Packet 9B rendering additions (not in the matrix; reported for review) ---
  loading: string;
  unavailableTitle: string;
  noAppointmentTitle: string;
  addAppointment: string;
  changeAppointment: string;
  appointmentWhoLabel: string;
  appointmentDateLabel: string;
  appointmentTimeLabel: string;
  changeKindLabel: string;
  changeCorrect: string;
  changeRescheduled: string;
  changeCancelled: string;
  groupEmpty: string;
  myQuestionsHeading: string;
  includeQuestion: (text: string) => string;
  recordsInPeriod: (count: number) => string;
  saved: string;
  editQuestion: string;
  editQuestionNamed: (text: string) => string;
  removeQuestion: string;
  removeQuestionNamed: (text: string) => string;
};

/** Packet 9C care-summary preview and print copy (09-bilingual-copy-matrix.md Section 4). */
export type CareSummaryMessages = {
  title: string;
  selectedOnly: string;
  scopeHeading: string;
  carePlanHeading: string;
  organisationHeading: string;
  measurementsHeading: string;
  medicationHeading: string;
  questionsHeading: string;
  limitationsHeading: string;
  patientReported: string;
  missingLimitation: string;
  approveAction: string;
  approvalMeaning: string;
  printAction: string;
  printOpened: string;
  printUnavailable: string;
  sourceChanged: string;
  hashMismatch: string;
  backToPreparation: string;
  // --- Packet 9C rendering additions (not in the matrix; reported for review) ---
  intakeActivityHeading: string;
  purposeAppointment: (label: string) => string;
  purposeRoutine: string;
  periodLine: (range: string) => string;
  preparedOn: (dateTime: string) => string;
  timeNotRecorded: string;
  approximately: (time: string) => string;
  loading: string;
  unavailableTitle: string;
  approvedNote: string;
  printUnknown: string;
  attemptsHeading: string;
  /**
   * Packet 11C Task 8 (Addendum A3), care-summary-notices.11c.1; Addendum B, Task B1a. `label` is the heading of the printed
   * summary's care-draft notice section (locale asset care-summary.section.draft-notices, care-summary-locale.11c.1). The notice
   * text itself is no longer mirrored here: its one runtime source is the approved copy (AI_LANGUAGE_COPY.careDraftNotices), stored
   * in the snapshot's CARE_DRAFT_NOTICE blocks. New wording; human acceptance pending.
   */
  draftNotices: { label: string };
  /** Packet 11C B1a (D3): an unapproved summary made by an earlier version must be prepared again. Human acceptance pending. */
  templateSuperseded: string;
};

/**
 * Packet 11 shared AI disclosure copy (11-bilingual-copy-state-matrix.md, APPROVED_PACKET_11; Packet 11C Addendum B, Task B3). Every
 * key is the approved row of the same name (`ai.cancel`, `ai.remoteTitle`, `ai.remoteLimit`, `ai.pattern.confirm`,
 * `ai.careSummary.confirm`) EXCEPT `remoteBody`. The disclosure appears only before a remote call, never while NOT_ACTIVATED.
 */
export type AiMessages = {
  cancel: string;
  remoteTitle: string;
  /**
   * ai-disclosure.11c.1 (coordinator ruling 2026-10-08; human acceptance pending). Replaces the approved row, which named Kie.ai and
   * said the selected synthetic information is sent: the route is Direct DeepSeek (D2) and the request is value-blind (approved
   * glosses, headings, slot ids and budgets only; no value, date, name or the person's own text). No consent or confidentiality claim.
   */
  remoteBody: string;
  remoteLimit: string;
  /** The disclosure's primary action in the Recorded-history explanation flow. */
  pattern: { confirm: string };
  /**
   * The care-summary organisation flow (Packet 11C Task B4b). Every key is the approved row of the same name (`ai.careSummary.*`,
   * matrix Section 4) EXCEPT `notEligible` (ai-care-summary.11c.1, new wording, human acceptance pending): the plain line for a preview
   * the AI path cannot organise (nothing is sent). Presentation (placement and order of these lines): human acceptance pending.
   */
  careSummary: { confirm: string; action: string; loading: string; resultTitle: string; resultBody: string; fallback: string; changed: string; notEligible: string };
  /**
   * ai-remote-use.11c.1 (Packet 11C B4a; human acceptance pending): the short, non-technical line shown with the standard (deterministic)
   * wording when remote use was not accepted (the disclosure was cancelled, or no acceptance exists). Nothing was sent.
   */
  remoteNotAccepted: string;
  /** Approved shared rows (matrix Section 2), first used by the care-summary flow (Packet 11C B4b). */
  unavailable: string;
  cancelled: string;
  retry: string;
  /**
   * Packet 11C Addendum C, Task C4: the approved rows `ai.demoTag` and `ai.resultCheck` (matrix Section 2, APPROVED_PACKET_11), verbatim.
   * They mark AI-sourced output only: the hashed AI_MARKING block of an AI-assisted care summary (renderer/template 11c.2) and the
   * on-screen tags of an AI-sourced history explanation. Never shown on deterministic output. Placement and appearance: human
   * acceptance pending.
   */
  demoTag: string;
  resultCheck: string;
};

/**
 * Packet 11C Addendum C, Task C6 (new wording, human acceptance pending): the label of the demo passcode field the AI disclosure shows
 * while no passcode is held for the app session. Kept outside `ai` so the approved and frozen disclosure rows stay byte-identical.
 */
export type AiAccessMessages = {
  passcodeLabel: string;
};

/**
 * Packet 11C Addendum C, Task C2: the "Keep wording on this device" setting on the More screen (hybrid spec D11). ai-wording-setting.11c.2:
 * `keepOnDeviceLabel` en is fixed by the spec; the zh label (U04) and both explanatory lines (U05) are owner-decided wording (owner UI
 * decisions 2026-10-09, owner-ui-decisions-2026-10-09.md), not APPROVED_PACKET_11 rows. Kept outside the approved groups so their rows
 * stay byte-identical.
 */
export type AiWordingMessages = {
  keepOnDeviceLabel: string;
  keepOnDeviceBody: string;
};

/**
 * Owner UI decision U12 (ai-history-fallback.11c.1; owner-ui-decisions-2026-10-09.md, verbatim; owner-decided, not APPROVED_PACKET_11):
 * the short history line shown with the standard wording after a remote request was actually attempted (POSTed) and then failed or was
 * refused. Never for ordinary deterministic use, private mode, or a request that was not attempted. Kept outside the approved groups.
 */
export type AiHistoryFallbackMessages = {
  unavailableAfterRequest: string;
};

/**
 * Owner decision 2026-10-12 (AI credit dialog): the dialog shown when an AI wording request was refused because the demo's AI credit is
 * used up (the daily spend limit or the DeepSeek balance). en-SG: the owner's wording (the history line's "explanation" is the owner's
 * allowed edit). zh-SG: drafts, Chinese acceptance deferred (zh-SG requests are never sent to the provider, so it is never shown).
 * Kept outside the approved groups.
 */
export type AiCreditLimitMessages = {
  title: string;
  careSummaryBody: string;
  historyBody: string;
  /** Tell JagaOn understands more (2026-10-14): the feelings chat continues with JagaOn's standard questions. */
  feelingsChatBody: string;
  ok: string;
};

/** Voice transcription slice copy (voice-copy.13s.1). Every row is human acceptance pending. */
export type VoiceMessages = {
  entry: string;
  disclosure: { title: string; body: string; accept: string; decline: string };
  state: {
    listening: string;
    stop: string;
    cancel: string;
    stopping: string;
    cancelled: string;
    timedOut: string;
    permissionDenied: string;
    unsupported: string;
    unavailable: string;
  };
  review: {
    heading: string;
    transcriptLabel: string;
    nothingFound: string;
    unitUnstated: string;
    confirm: string;
    discard: string;
  };
  redirect: { body: string; transcribedNote: string };
  /**
   * Owner decision 2026-10-14 (distress safety): the only content shown when a distress cue was said. English owner-approved; Chinese
   * drafts (human acceptance pending). Each contact row is a separate link; the numbers are part of the text.
   */
  distress: {
    message: string;
    sosCall: string;
    sosWhatsApp: string;
    sosHours: string;
    mindlineCall: string;
    mindlineWhatsApp: string;
    mindlineHours: string;
    danger: string;
    trustedPerson: string;
  };
  /**
   * Owner decision 2026-10-14 (Tell JagaOn understands more, design §3.1 step 3): the Feeling card. English owner-scoped; Chinese drafts
   * (human acceptance pending; feelings are recognised in English only). The kind sentence shown after saving comes from the reviewed
   * bank (`note-kind-sentences`), not from here.
   */
  feeling: {
    heading: string;
    textLabel: string;
    saveAsNote: string;
    talkItThrough: string;
    skip: string;
    savedToNotes: string;
    notSaved: string;
    skipped: string;
    textRequired: string;
  };
  /** Owner decision 2026-10-14 (design §4): the Activity card. English owner-scoped; Chinese drafts (human acceptance pending). */
  activity: {
    heading: string;
    labelLabel: string;
    durationLabel: string;
    durationHint: string;
    durationInvalid: string;
    noDuration: string;
    save: string;
    skip: string;
    saved: string;
    notSaved: string;
    skipped: string;
    labelRequired: string;
    /** Short display names of the activity-event categories ("Walk · 30 minutes"). */
    categories: Readonly<Record<"WALKING" | "FLEXIBILITY_OR_MOBILITY" | "STRENGTH" | "AEROBIC" | "HOUSEHOLD_ACTIVITY" | "OTHER", string>>;
  };
};

/**
 * Tell JagaOn understands more (design §3.1): the feelings chat dialog. en-SG: the AI notice is the owner's approved wording
 * (2026-10-14), the rest is new wording; zh-SG: drafts, human acceptance pending (English-only hackathon scope).
 */
export type FeelingsChatMessages = {
  title: string;
  notice: string;
  continue: string;
  saveWithoutAi: string;
  you: string;
  jagaon: string;
  answerLabel: string;
  send: string;
  skip: string;
  endChat: string;
  loading: string;
  questionAnnouncement: (question: string) => string;
  fallbackNotice: string;
  creditLimitNotice: string;
  wrapUpTitle: string;
  summaryLabel: string;
  summaryHint: string;
  doctorQuestionTitle: string;
  doctorQuestionHint: string;
  addToQuestions: string;
  noThanks: string;
  questionAdded: string;
  questionNotAdded: string;
  saveNote: string;
  dontSave: string;
  saving: string;
  saved: string;
  saveFailed: string;
  done: string;
};

export type AppMessages = {
  /** Packet 10 data, backup, restore, deletion and integrity copy. */
  packet10: Packet10Messages;
  /** Packet 11 shared AI disclosure copy (Task B3). */
  ai: AiMessages;
  /** Packet 11C Addendum C (C6): the demo passcode field of the AI disclosure (human acceptance pending). */
  aiAccess: AiAccessMessages;
  /** Packet 11C Addendum C (C2): the "Keep wording on this device" setting (ai-wording-setting.11c.2; owner-decided U04/U05). */
  aiWording: AiWordingMessages;
  /** Owner UI decision U12: the history fallback line after an attempted remote request (ai-history-fallback.11c.1). */
  aiHistoryFallback: AiHistoryFallbackMessages;
  /** Owner decision 2026-10-12: My notes, reached from More (first version: the destination only). */
  myNotes: {
    title: string;
    empty: string;
    /** Owner decision 2026-10-14 (personal notes): the stored notes list, this week's themes and deleting one note. */
    loading: string;
    unavailable: string;
    themesHeading: string;
    /** One line per recurring theme, e.g. "Sleep came up in 3 notes this week." (`theme` is a `themeLabels` value). */
    themeCount: (theme: string, count: number) => string;
    /** Descriptive labels only (never causes or diagnoses), keyed by the closed note theme keys. */
    themeLabels: Readonly<Record<NoteThemeKey, string>>;
    themesLabel: string;
    conversation: string;
    speakerJagaOn: string;
    speakerYou: string;
    deleteNote: string;
    /** The record label shown in the existing permanent-deletion dialog. */
    noteRecordLabel: string;
    deleted: string;
  };
  /** Owner decision 2026-10-12 (AI credit dialog): the used-up AI credit dialog (en owner wording; zh drafts, acceptance deferred). */
  aiCreditLimit: AiCreditLimitMessages;
  /** Voice transcription slice (voice-copy.13s.1; human acceptance pending). */
  voice: VoiceMessages;
  shared: SharedMessages;
  today: TodayMessages;
  glucose: GlucoseMessages;
  readingTime: ReadingTimeMessages;
  insulin: InsulinMessages;
  meal: MealMessages;
  medication: MedicationMessages;
  food: FoodMessages;
  more: MoreMessages;
  settings: SettingsMessages;
  help: HelpMessages;
  onboarding: OnboardingMessages;
  history: HistoryMessages;
  schedule: ScheduleMessages;
  preventiveCare: PreventiveCareMessages;
  carePreparation: CarePreparationMessages;
  careSummary: CareSummaryMessages;
  /** Tell JagaOn understands more: the feelings chat dialog (en notice owner-approved 2026-10-14; zh drafts, acceptance pending). */
  feelingsChat: FeelingsChatMessages;
};
