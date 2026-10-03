export type { SupportedLocale } from "../domain/patient-settings/locale";

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
  aspartPurpose: string;
  aspartUse: string;
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
};

export type AppMessages = {
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
};
