"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { Instant } from "@/domain/shared/time";
import { getMessages } from "@/i18n/get-messages";
import type { AppMessages } from "@/i18n/types";
import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { DemoBoundaryNotice } from "@/components/demo/DemoBoundaryNotice";
import { DEMO_BOUNDARY_PLACEMENT } from "@/components/demo/demo-boundary-placement";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { TOP_LEVEL_SCREENS, type ScreenId } from "./screen-manifest";
import { RecordedHistoryScreen } from "./screens/RecordedHistoryScreen";
import { MyNotesScreen } from "./screens/MyNotesScreen";
import { MedicationScheduleScreen } from "./screens/MedicationScheduleScreen";
import {
  createAppointmentNoteSelectionRepository,
  type AppointmentNoteSelectionRepository,
} from "@/application/history/appointment-note-selection";
import type { DemoOnboardingStoragePort } from "@/application/onboarding/demo-onboarding-repository";
import { AppShell } from "./AppShell";
import { TodayScreen } from "./screens/TodayScreen";
import { useCareNudgeSummary } from "./hsa/care-nudges";
import { GlucoseEntryScreen } from "./screens/GlucoseEntryScreen";
import { ReadingTimeScreen } from "./screens/ReadingTimeScreen";
import { InsulinEntryScreen } from "./screens/InsulinEntryScreen";
import { MealEntryScreen } from "./screens/MealEntryScreen";
import { MedicationInformationScreen } from "./screens/MedicationInformationScreen";
import { NearbyFoodScreen } from "./screens/NearbyFoodScreen";
import { FoodGeneralInfoScreen } from "./screens/FoodGeneralInfoScreen";
import { MoreScreen } from "./screens/MoreScreen";
import { HelpScreen } from "./screens/HelpScreen";
import { TellJagaOnScreen } from "./voice/TellJagaOnScreen";
import { browserWebSpeechSupported, checkVoiceAccess, checkVoiceProviderAnswer, VOICE_PROVIDER_LOADERS, type VoiceTranscriberLoader } from "./voice/voice-provider-wiring";
import { VoiceProviderSettingsSection } from "./voice/VoiceProviderSettingsSection";
import { DEV_SETTINGS_ENABLED } from "./dev-settings-flag";
import {
  readVoiceProviderPreference,
  resolveVoiceProvider as resolveVoiceProviderChoice,
  writeVoiceProviderPreference,
  type VoiceAccessCheck,
  type VoiceAccessMode,
  type VoiceProviderId,
  type VoiceProviderProbeAnswer,
  type VoiceProviderResolution,
} from "@/application/voice/voice-provider-selection";
import { createVoiceJournalSave, createVoiceSaveWithRefresh } from "./voice/voice-journal-save";
import { createFeelingsChatStorage } from "./feelings/feelings-chat-storage";
import { createFeelingsChatClient } from "@/application/feelings-chat/feelings-chat-client";
import type { FeelingsChatPort } from "@/application/feelings-chat/feelings-chat-port";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";
import {
  createBrowserJournalRuntime,
  JagaOnStorageLockedError,
  LocalStateCleanupUnconfirmedError,
  type BrowserJournalRuntimeOptions,
  type JagaOnRuntime,
} from "@/application/journal/browser-journal-runtime";
import type { StorageLockState } from "@/application/storage/integrity-gate";
import { createBrowserDatabaseDeletion, createBrowserDatasetCoordinator } from "@/application/storage/browser-dataset-lifecycle";
import { JAGAON_DATABASE_NAME } from "@/storage/table-catalogue";
import { createDeleteDatasetService } from "@/storage/delete-dataset";
import { Banner } from "./primitives/Card";
import { DataBackupScreen, type DataBackupView } from "./data/DataBackupScreen";
import type { DeleteAllPort } from "./data/data-ports";
import { IntegrityShell } from "./data/IntegrityShell";
import { DeletionInProgress } from "./data/DeletionInProgress";
import { CreateBackupPanel } from "./data/CreateBackupPanel";
import { RestoreBackupPanel } from "./data/RestoreBackupPanel";
import type { RestorePort } from "./data/data-ports";
import { createRestoreService } from "@/application/restore/restore-service";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import type { TodayJournalViewModel } from "@/application/journal/journal-contracts";
import type { RecordId } from "@/domain/shared/identifiers";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import {
  createBrowserOnboardingStorage,
  createDemoOnboardingRepository,
  type DemoOnboardingRepository,
} from "@/application/onboarding/demo-onboarding-repository";
import { OnboardingFlow, type OnboardingExit } from "./onboarding/OnboardingFlow";
import { MyMedicinesScreen, type MyMedicinesView } from "./screens/MyMedicinesScreen";
import { PreventiveCareScreen } from "./screens/PreventiveCareScreen";
import { CarePreparationScreen, type CarePreparationSelection } from "./screens/CarePreparationScreen";
import { CareSummaryPreviewScreen, type CareSummaryAiWordingPort } from "./screens/CareSummaryPreviewScreen";
import { createBrowserPrintPort, type PrintPort } from "./care-preparation/PrintPort";
import { createBrowserAiAssistance } from "@/application/ai/browser-history-explainer";
import type { AiInvocationAuditPort } from "@/application/ai/ai-provider-port";
import type { RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import type { PatternExplainerPort } from "./history/PatternExplanationPanel";
import { isTranscriptExtractionActivated } from "@/application/transcript-extraction/transcript-extraction-qualification";
import { createVoiceRemoteExtraction } from "@/application/transcript-extraction/voice-remote-extraction-adapter";

// --- Section: Navigation state --------------------------------------------

type NavigationEntry = {
  screen: ScreenId;
  params?: Record<string, string>;
};

/** Packet 10A: delete-all is wired by the app because it owns the runtime lifecycle. */
export type DeleteAllPortFactory = (hooks: { databaseName: string; closeRuntime: () => void; clearLocalState: () => void }) => DeleteAllPort;

function browserDeleteAllPort(hooks: { databaseName: string; closeRuntime: () => void; clearLocalState: () => void }): DeleteAllPort {
  return createDeleteDatasetService({
    databaseName: hooks.databaseName,
    now: () => new Date().toISOString() as never,
    coordinator: createBrowserDatasetCoordinator(hooks.databaseName),
    deletion: createBrowserDatabaseDeletion(),
    closeOwnConnections: hooks.closeRuntime,
    clearLocalState: hooks.clearLocalState,
  });
}

/** Packet 10C: restore is wired by the app because it replaces the dataset under the runtime. */
export type RestorePortFactory = (hooks: { databaseName: string; closeRuntime: () => void }) => RestorePort;

function browserRestorePort(hooks: { databaseName: string; closeRuntime: () => void }): RestorePort {
  return createRestoreService({
    databaseName: hooks.databaseName,
    now: () => new Date().toISOString() as never,
    crypto: () => createWebCryptoPort(),
    coordinator: createBrowserDatasetCoordinator(hooks.databaseName),
    closeRuntime: hooks.closeRuntime,
  });
}

type JagaOnAppProps = {
  /** Packet 10C: injected restore service (deterministic in tests). */
  restorePortFactory?: RestorePortFactory;
  runtimeFactory?: (databaseName?: string, options?: BrowserJournalRuntimeOptions) => Promise<JagaOnRuntime>;
  /** Packet 10A: injected whole-dataset deletion (deterministic in tests). */
  deleteAllPortFactory?: DeleteAllPortFactory;
  /** Injected for tests; defaults to the single versioned browser storage key. */
  onboardingRepositoryFactory?: () => DemoOnboardingRepository;
  /** Packet 7A: storage port for the local appointment-note selection. */
  appointmentNoteStorageFactory?: () => DemoOnboardingStoragePort;
  /** Packet 9C: injected browser printing (deterministic in tests). */
  printPortFactory?: () => PrintPort;
  /**
   * Packet 11C B2b: builds the history explanation (one hybrid service and one pattern explainer) from an opened runtime's ports.
   * Packet 11C B4b: the same wiring also builds the care-summary AI wording over the SAME hybrid service. Called once per runtime;
   * injected in tests to observe that (and to add a test manifest and a fake route).
   */
  aiAssistanceFactory?: AiAssistanceFactory;
  /**
   * Packet 13 slice: loads the voice transcriber after the voice-cloud disclosure was accepted. Injected in tests and the isolated e2e
   * harness (a scripted fake there; never a production default). Web Speech: when this or `voiceAvailabilityProbe` is injected, the
   * screen runs the single-provider (TRTC-labelled) path as before; otherwise the production provider choice below applies.
   */
  voiceTranscriberLoader?: (accessPasscode: () => string | null, access?: VoiceAccessMode) => Promise<VoiceTranscriberPort>;
  /**
   * Review I-5: the credential-free voice availability probe, called when Tell JagaOn opens (before its disclosure). Injected in tests
   * and the isolated e2e harness (see `voiceTranscriberLoader`). Owner decision 2026-10-12 (optional passcodes): it may also answer
   * `{ available, passcodeRequired }` (absent flag: required).
   */
  voiceAvailabilityProbe?: () => Promise<boolean | Readonly<{ available: boolean; passcodeRequired?: boolean }>>;
  /**
   * Web Speech (owner-approved scope 2026-10-11; draft): the production provider choice. The deployment-enabled providers (default: the
   * credential-free probe), one loader per provider (default: TRTC and Web Speech by dynamic import), the browser's speech-recognition
   * support (default: feature detection), the build-time developer-settings flag (default: `DEV_SETTINGS_ENABLED`, dev-settings-flag.ts) and
   * the per-browser storage of the developer's choice (default: the browser storage port). Injected in tests.
   */
  /**
   * Owner decision 2026-10-12 (optional passcodes): the probe may also say whether the demo passcode is required (`VoiceAccessCheck`;
   * a bare provider list means required). Default: `checkVoiceAccess` (one probe call for both).
   */
  voiceProvidersProbe?: () => Promise<readonly VoiceProviderId[] | VoiceAccessCheck>;
  /** Round 6: the panel's probe telling a failed check apart (default: the production answer check, or `voiceProvidersProbe` when injected). */
  voiceProviderAnswerProbe?: () => Promise<VoiceProviderProbeAnswer>;
  voiceProviderLoaders?: Readonly<Partial<Record<VoiceProviderId, VoiceTranscriberLoader>>>;
  webSpeechSupported?: () => boolean;
  devSettingsEnabled?: boolean;
  voicePreferenceStorageFactory?: () => DemoOnboardingStoragePort;
  /**
   * Tell JagaOn understands more (owner decision 2026-10-14): the feelings chat port. Default: the browser client of the same-origin
   * route POST /api/ai/feelings (no passcode: the route has none of its own). Injected in tests (the fake port; never a live call).
   */
  feelingsChatPortFactory?: () => FeelingsChatPort;
};

/**
 * Packet 11C B4b: `carePreparation` is the runtime's care-preparation port pair; `careSummary` is null when no care wording is wired.
 * Packet 11C Addendum C, C3 (deliberate change): no app-session disclosure is passed any more (the B3 session is gone):
 * acceptance is per explicit request, carried by that request from the screen's dialog.
 */
export type AiAssistanceFactory = (ports: {
  history: RecordedHistoryQueryPort;
  carePreparation: JagaOnRuntime["carePreparation"];
  audit: AiInvocationAuditPort;
  /**
   * Packet 11C Addendum C (C2): the patient's "Keep wording on this device" setting, read per request (never a captured value). Fix
   * round 1 (I-1): awaited: this tab's choice, else the stored value (another tab's change counts at once; unreadable: on).
   */
  privateMode: () => Promise<boolean>;
  /** C2 fix round 1 (I-1): this tab's in-memory value, for render-time offers only (kept in step by the change notice). */
  privateModeHint: () => boolean;
}) => { history: PatternExplainerPort; careSummary: CareSummaryAiWordingPort | null };

/** Startup gate: onboarding until setup is completed or explicitly skipped. */
type Phase =
  | { kind: "LOADING" }
  | { kind: "ONBOARDING"; initial: DemoOnboardingStateV1 | null }
  | { kind: "APP" };

function browserOnboardingRepository(): DemoOnboardingRepository {
  return createDemoOnboardingRepository(createBrowserOnboardingStorage());
}

/**
 * Owner decision 2026-10-12 (optional passcodes): a provider probe's answer as providers plus whether the demo passcode is required. A
 * bare list (an injected test probe) or anything unreadable keeps the passcode required (fail safe); unreadable enables nothing.
 */
function voiceAccessOf(probed: unknown): VoiceAccessCheck {
  if (Array.isArray(probed)) return { providers: probed as VoiceProviderId[], passcodeRequired: true };
  if (probed && typeof probed === "object" && Array.isArray((probed as VoiceAccessCheck).providers)) {
    return { providers: (probed as VoiceAccessCheck).providers, passcodeRequired: (probed as VoiceAccessCheck).passcodeRequired !== false };
  }
  return { providers: [], passcodeRequired: true };
}

/** Packet 13 slice: a runtime without the voice ports (older test runtimes) shows voice as unavailable; nothing is read or stored. */
const UNAVAILABLE_TERMINOLOGY = Object.freeze({
  directory: async () => Object.freeze({ terms: [], names: [] }),
  activeMedicines: async () => [],
  remember: async () => Object.freeze({ kind: "FAILED" }),
  // Terminology review Critical #1: nothing to list, change or forget without the voice ports.
  list: async () => [],
  change: async () => Object.freeze({ kind: "REJECTED", code: "TERM_NOT_FOUND" }),
  forget: async () => Object.freeze({ kind: "FAILED" }),
});

/** The feelings chat's production port: one client of the same-origin route, created once per app (it calls nothing until a chat turn). */
function defaultFeelingsChatPort(): FeelingsChatPort {
  return createFeelingsChatClient();
}

/** Completion of a delete-all is handled once, by the app-level port wrapper. */
const noop = () => undefined;

const EMPTY_TODAY: TodayJournalViewModel = Object.freeze({
  entries: [],
  unavailable: false,
});

export function JagaOnApp({
  runtimeFactory = createBrowserJournalRuntime,
  onboardingRepositoryFactory = browserOnboardingRepository,
  appointmentNoteStorageFactory = createBrowserOnboardingStorage,
  printPortFactory = createBrowserPrintPort,
  deleteAllPortFactory = browserDeleteAllPort,
  restorePortFactory = browserRestorePort,
  aiAssistanceFactory = createBrowserAiAssistance,
  voiceTranscriberLoader,
  voiceAvailabilityProbe,
  voiceProvidersProbe: injectedProvidersProbe,
  voiceProviderAnswerProbe,
  voiceProviderLoaders = VOICE_PROVIDER_LOADERS,
  webSpeechSupported = browserWebSpeechSupported,
  devSettingsEnabled = DEV_SETTINGS_ENABLED,
  voicePreferenceStorageFactory = createBrowserOnboardingStorage,
  feelingsChatPortFactory = defaultFeelingsChatPort,
}: JagaOnAppProps = {}) {
  const printPort = useMemo(() => printPortFactory(), [printPortFactory]);
  const feelingsChatPort = useMemo(() => feelingsChatPortFactory(), [feelingsChatPortFactory]);
  const appointmentNotes = useMemo<AppointmentNoteSelectionRepository>(
    () =>
      createAppointmentNoteSelectionRepository(
        appointmentNoteStorageFactory(),
        () => new Date().toISOString() as never,
      ),
    [appointmentNoteStorageFactory],
  );
  const [repository, setRepository] = useState<DemoOnboardingRepository | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "LOADING" });
  const [onboarding, setOnboarding] = useState<DemoOnboardingStateV1 | null>(null);
  const fixture = useMemo(() => createDemoScenarioFixture(onboarding), [onboarding]);
  const [locale, setLocale] = useState<SupportedLocale>("en-SG");
  const messages = useMemo<AppMessages>(
    () => getMessages(locale),
    [locale],
  );

  const voiceProvidersProbe = injectedProvidersProbe ?? checkVoiceAccess;
  // Owner decision 2026-10-12 (optional passcodes): the panel needs only the providers of an injected probe (one stable function).
  const panelProbe = useMemo(
    () => voiceProviderAnswerProbe ?? (injectedProvidersProbe ? async () => voiceAccessOf(await injectedProvidersProbe()).providers : checkVoiceProviderAnswer),
    [voiceProviderAnswerProbe, injectedProvidersProbe],
  );
  /**
   * Web Speech (owner-approved scope 2026-10-11; draft): the voice provider choice. The developer's stored choice (read once on mount,
   * applied only while the developer-settings flag is on), the session activity that locks the selector, and the resolver the Tell
   * JagaOn screen calls at idle (on open and on every restart). The resolver never starts anything; a session's provider is fixed by
   * the screen. Changing the choice only remembers it (no microphone, no session, no fallback).
   */
  const voicePreferenceStorage = useMemo(() => {
    let port: DemoOnboardingStoragePort | null = null;
    return () => {
      try {
        return (port ??= voicePreferenceStorageFactory());
      } catch {
        return null;
      }
    };
  }, [voicePreferenceStorageFactory]);
  const [voicePreference, setVoicePreference] = useState<VoiceProviderId | null>(null);
  const voicePreferenceRef = useRef<VoiceProviderId | null>(null);
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  useEffect(() => {
    if (!devSettingsEnabled) return;
    let current = true;
    // Read once after mount (browser storage is not available while rendering on the server).
    void Promise.resolve().then(() => {
      if (!current) return;
      const stored = readVoiceProviderPreference(voicePreferenceStorage);
      voicePreferenceRef.current = stored;
      setVoicePreference(stored);
    });
    return () => {
      current = false;
    };
  }, [devSettingsEnabled, voicePreferenceStorage]);
  const selectVoiceProvider = useCallback(
    (provider: VoiceProviderId) => {
      if (!devSettingsEnabled || voiceSessionActive) return;
      voicePreferenceRef.current = provider;
      setVoicePreference(provider);
      // Remembered in this browser when storage allows; in this tab's memory either way. Nothing else happens.
      writeVoiceProviderPreference(voicePreferenceStorage, provider);
    },
    [devSettingsEnabled, voiceSessionActive, voicePreferenceStorage],
  );
  const legacyVoice = voiceTranscriberLoader !== undefined || voiceAvailabilityProbe !== undefined;
  const voiceLanguage = locale === "zh-SG" ? "zh" : "en";
  const resolveVoiceProvider = useCallback(async (): Promise<VoiceProviderResolution> => {
    const { providers: enabled, passcodeRequired } = voiceAccessOf(await voiceProvidersProbe());
    let supported = false;
    try {
      supported = webSpeechSupported() === true;
    } catch {
      supported = false;
    }
    const resolution = resolveVoiceProviderChoice({ enabled, webSpeechSupported: supported, language: voiceLanguage }, { devSettingsEnabled, stored: voicePreferenceRef.current });
    // No loader for the resolved provider: unavailable (never another provider).
    if (resolution.kind === "AVAILABLE" && !voiceProviderLoaders[resolution.provider]) return { kind: "UNAVAILABLE" };
    // Owner decision 2026-10-12 (optional passcodes): the screen skips its passcode step only when the probe said none is required.
    return resolution.kind === "AVAILABLE" ? { ...resolution, passcodeRequired } : resolution;
  }, [voiceProvidersProbe, webSpeechSupported, voiceLanguage, devSettingsEnabled, voiceProviderLoaders]);
  const loadProviderTranscriber = useCallback(
    (accessPasscode: () => string | null, provider: VoiceProviderId, access: VoiceAccessMode): Promise<VoiceTranscriberPort> => {
      const load = voiceProviderLoaders[provider];
      return load ? load(accessPasscode, access) : Promise.reject(new Error("VOICE_PROVIDER_UNAVAILABLE"));
    },
    [voiceProviderLoaders],
  );
  const loadLegacyTranscriber = useCallback(
    (accessPasscode: () => string | null, _provider: VoiceProviderId, access: VoiceAccessMode): Promise<VoiceTranscriberPort> => (voiceTranscriberLoader ?? VOICE_PROVIDER_LOADERS.TRTC)(accessPasscode, access),
    [voiceTranscriberLoader],
  );
  const legacyAvailability = useCallback(async () => {
    if (voiceAvailabilityProbe) return voiceAvailabilityProbe();
    const { providers, passcodeRequired } = voiceAccessOf(await voiceProvidersProbe());
    return { available: providers.includes("TRTC"), passcodeRequired };
  }, [voiceAvailabilityProbe, voiceProvidersProbe]);

  const [stack, setStack] = useState<NavigationEntry[]>([
    { screen: "TODAY" },
  ]);
  const [runtime, setRuntime] = useState<JagaOnRuntime | null>(null);
  const runtimeRef = useRef<JagaOnRuntime | null>(null);
  /**
   * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting. The state drives the More
   * screen's checkbox (null until the open runtime's stored value is read); the ref is what the one AI wiring reads per request
   * (`readKeepWordingOnDevice`), so a change applies from the next explicit request with no reload or rebuild. A stored value that
   * cannot be read counts as on (fail closed: nothing is sent).
   */
  const [keepWordingOnDevice, setKeepWordingOnDevice] = useState<boolean | null>(null);
  const keepWordingRef = useRef(false);
  /** Fix round 1 (M-1): a choice made in this session whose save failed; it survives a reopen (stored || choice) until saved. */
  const unsavedKeepWordingChoice = useRef<boolean | null>(null);
  const readKeepWordingOnDevice = useCallback(() => keepWordingRef.current, []);
  /**
   * Fix round 1 (I-1): the per-request value the AI wiring awaits: this tab's choice, else the STORED value (another tab may have turned
   * it on without this tab knowing yet); an unreadable stored value counts as on.
   */
  const keepWordingAwaitedFor = useCallback(
    (open: JagaOnRuntime) => async () =>
      keepWordingRef.current ||
      (await Promise.resolve()
        .then(() => open.keepWordingOnDevice.read())
        .catch(() => true)),
    [],
  );
  /** Packet 10A: bumping the epoch re-opens the dataset (retry, delete-all restart). */
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  const runtimeOptions = useRef<BrowserJournalRuntimeOptions>({});
  const [storageLock, setStorageLock] = useState<StorageLockState | null>(null);
  const [datasetDeleted, setDatasetDeleted] = useState(false);
  /** Packet 10C: resolves once a restored dataset finished reconciliation (or locked). */
  const reconciliationWaiter = useRef<((outcome: "COMPLETED" | "LOCKED") => void) | null>(null);
  const [lockRestoreOpen, setLockRestoreOpen] = useState(false);
  /** Corrective Pass A item 3: an issued delete request is shown app-wide until it settles. */
  const [deletionInFlight, setDeletionInFlight] = useState<{ waitingForTab: boolean } | null>(null);
  /** True when a destructive operation closed this tab's runtime and must reopen it on failure. */
  const runtimeClosedByOperation = useRef(false);
  const onDatasetDeletedRef = useRef<(localStateCleared: boolean) => void>(() => undefined);
  /**
   * Corrective Pass B item 5 / Pass C: every local-state owner, attempted even
   * when another fails; true only when all confirm their keys are gone.
   */
  const clearLocalStateOwnersRef = useRef<() => boolean>(() => false);
  /**
   * Corrective Pass C startup gate. Persisted setup is trusted only after the
   * first runtime reported the durable LOCAL_STATE_CLEANUP_PENDING marker
   * (`stale`: the marker was present, the dataset was newly created under a
   * completed setup, or the marker could not be confirmed).
   */
  const startupSetupRef = useRef<DemoOnboardingStateV1 | null | undefined>(undefined);
  const startupRuntimeRef = useRef<{ stale: boolean } | undefined>(undefined);
  const startupResolved = useRef(false);
  const repositoryRef = useRef<DemoOnboardingRepository | null>(null);
  const [today, setToday] = useState<TodayJournalViewModel>(EMPTY_TODAY);
  /** True once a saved setup supplied the locale; it then wins over IndexedDB. */
  const onboardingLocaleRef = useRef(false);

  /** Local setup state that belongs to a deleted dataset is ignored: fresh setup, no profile. */
  function enterFreshSetup() {
    onboardingLocaleRef.current = false;
    setOnboarding(null);
    setStack([{ screen: "TODAY" }]);
    setPhase({ kind: "ONBOARDING", initial: null });
    // No success claim here: the banner follows confirmed cleanup only.
    setDatasetDeleted(false);
  }

  /** Decides the first screen once both the persisted setup and the first runtime outcome are known. */
  function resolveStartup() {
    if (startupResolved.current || startupSetupRef.current === undefined || startupRuntimeRef.current === undefined) return;
    startupResolved.current = true;
    const saved = startupSetupRef.current;
    if (startupRuntimeRef.current.stale) {
      enterFreshSetup();
      return;
    }
    setOnboarding(saved);
    if (saved) {
      onboardingLocaleRef.current = true;
      setLocale(saved.locale);
    }
    setPhase(saved && (saved.status === "COMPLETED" || saved.status === "SKIPPED") ? { kind: "APP" } : { kind: "ONBOARDING", initial: saved });
  }

  /** Completed or skipped setup that a newly created dataset would otherwise inherit. */
  function persistedSetupIsComplete(): boolean {
    try {
      const status = onboardingRepositoryFactory().load()?.status;
      return status === "COMPLETED" || status === "SKIPPED";
    } catch {
      return false;
    }
  }

  // Effects reach the startup helpers through a ref so their dependencies stay stable.
  const startup = useRef({ enterFreshSetup, resolveStartup, persistedSetupIsComplete });
  startup.current = { enterFreshSetup, resolveStartup, persistedSetupIsComplete };

  useEffect(() => {
    let active = true;
    let createdRuntime: JagaOnRuntime | null = null;
    const { enterFreshSetup, resolveStartup, persistedSetupIsComplete } = startup.current;

    let unsubscribe: () => void = () => undefined;
    let unsubscribeKeepWording: () => void = () => undefined;

    const firstOpen = startupRuntimeRef.current === undefined;
    const completeSetupAtOpen = firstOpen && persistedSetupIsComplete();
    // A dataset created under a completed setup is born with the cleanup marker
    // (atomically with its identity), so the setup can never be trusted later.
    if (completeSetupAtOpen && !runtimeOptions.current.localStateCleanup) {
      runtimeOptions.current = { ...runtimeOptions.current, localStateCleanup: { requestedAt: new Date().toISOString() as Instant, when: "IF_CREATED" } };
    }

    void runtimeFactory(undefined, runtimeOptions.current)
      .then(async (nextRuntime) => {
        createdRuntime = nextRuntime;
        runtimeRef.current = nextRuntime;
        // A recovery permission and a cleanup-marker request apply to one successful open only.
        const { localStateCleanup: _persisted, ...rest } = runtimeOptions.current;
        void _persisted;
        runtimeOptions.current = { ...rest, resumeFailedRestore: false };
        // Corrective Pass C: the durable marker is read before any persisted setup is trusted.
        const pending = await nextRuntime.localStateCleanup.isPending().catch(() => true);
        if (!active) {
          nextRuntime.close();
          return;
        }
        if (firstOpen) {
          // Corrective Pass A rule, kept as defence in depth: a newly created dataset
          // never inherits a completed setup even if no marker was reported.
          const inherited = !pending && completeSetupAtOpen && nextRuntime.datasetLifecycle === "CREATED";
          if (inherited) clearLocalStateOwnersRef.current();
          startupRuntimeRef.current = { stale: pending || inherited };
          resolveStartup();
        } else if (pending) {
          enterFreshSetup();
        }
        // Every owner is retried; the marker goes only after all of them confirm,
        // and "Local data deleted" only after the marker is gone.
        if (pending && clearLocalStateOwnersRef.current()) {
          const cleaned = await nextRuntime.localStateCleanup.complete().then(
            () => true,
            () => false,
          );
          if (cleaned && active) setDatasetDeleted(true);
        }
        unsubscribe = nextRuntime.onIntegrityLock((lock) => {
          if (active) setStorageLock(lock);
        });
        reconciliationWaiter.current?.("COMPLETED");
        reconciliationWaiter.current = null;
        const [resolvedLocale, todayView, keepOnDevice] = await Promise.all([
          nextRuntime.resolveLocale(),
          nextRuntime.query.loadToday(),
          // Packet 11C Addendum C (C2): read before the AI wiring exists; unreadable counts as on (fail closed).
          Promise.resolve()
            .then(() => nextRuntime.keepWordingOnDevice.read())
            .catch(() => true),
        ]);
        if (!active) {
          nextRuntime.close();
          return;
        }
        // Fix round 1 (M-1): a choice whose save failed in this session is not silently reverted by the reopened dataset.
        const effective = keepOnDevice || unsavedKeepWordingChoice.current === true;
        keepWordingRef.current = effective;
        setKeepWordingOnDevice(effective);
        // Fix round 1 (I-1): another tab's stored change re-reads the value and updates this tab's in-memory value and checkbox.
        try {
          unsubscribeKeepWording = nextRuntime.keepWordingOnDevice.subscribe(() => {
            void Promise.resolve()
              .then(() => nextRuntime.keepWordingOnDevice.read())
              .catch(() => true)
              .then((stored) => {
                if (!active) return;
                const value = stored || unsavedKeepWordingChoice.current === true;
                keepWordingRef.current = value;
                setKeepWordingOnDevice(value);
              });
          });
        } catch {
          // Without change notices the awaited stored value still decides every request.
        }
        setRuntime(nextRuntime);
        // The setup's own locale wins once onboarding state exists.
        setLocale((current) => (onboardingLocaleRef.current ? current : resolvedLocale));
        setToday(todayView);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // A marker that could not be persisted fails closed: persisted setup is not trusted.
        const unconfirmed = error instanceof LocalStateCleanupUnconfirmedError;
        if (firstOpen) {
          startupRuntimeRef.current = { stale: unconfirmed };
          resolveStartup();
        } else if (unconfirmed) {
          enterFreshSetup();
        }
        // A locked dataset shows only the neutral recovery shell (spec 9.4). Browser
        // storage that cannot open at all keeps the Packet 6 unavailable state.
        if (error instanceof JagaOnStorageLockedError && error.lock.kind !== "STORAGE_UNAVAILABLE") {
          setLockRestoreOpen(false);
          setStorageLock(error.lock);
        } else setToday({ entries: [], unavailable: true });
        reconciliationWaiter.current?.("LOCKED");
        reconciliationWaiter.current = null;
      });

    return () => {
      active = false;
      unsubscribe();
      unsubscribeKeepWording();
      createdRuntime?.close();
    };
  }, [runtimeFactory, runtimeEpoch]);

  // Load the onboarding state on the client only (never during server
  // rendering). Malformed state has already been cleared by the repository.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const { resolveStartup } = startup.current;
      const repo = onboardingRepositoryFactory();
      const saved = repo.load();
      repositoryRef.current = repo;
      startupSetupRef.current = saved;
      setRepository(repo);
      // Nothing persisted: nothing to distrust, so fresh setup starts now and a later
      // runtime outcome never replaces progress made meanwhile. Otherwise wait for the marker.
      if (saved === null) {
        startupResolved.current = true;
        setPhase({ kind: "ONBOARDING", initial: null });
        return;
      }
      resolveStartup();
    });
    return () => {
      active = false;
    };
  }, [onboardingRepositoryFactory]);

  // Keep the document language in step with the UI so assistive technology
  // reads zh-SG copy with a Chinese voice.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  /**
   * Packet 11C B2b: one history explainer per opened runtime (stable identity across renders, locale changes and navigation; a
   * re-opened dataset gets a new one). Building it reads, writes and sends nothing: the history screen calls it only on the patient's
   * explicit "Show how this comparison was worked out", and with the shipped manifest that is deterministic and local.
   */
  /**
   * Packet 11C B4b: ONE AI wiring per opened runtime (stable identity): the history explainer and the care-summary wording share one
   * hybrid service, browser shell client and the runtime's audit port. Building it reads, writes and sends nothing; with the shipped
   * manifest the care wording is never available, so the preview never shows its action.
   * Packet 11C Addendum C, C3 (replaces the B3 once-per-app-session acceptance): there is no app-level disclosure state. Each explicit
   * request carries its own decision from the dialog its screen showed for it; nothing is accepted for later requests or the other flow.
   */
  // Packet 11C Addendum C (C2): plus the "Keep wording on this device" setting, as a function read per request.
  const aiAssistance = useMemo(
    () =>
      runtime
        ? aiAssistanceFactory({ history: runtime.history, carePreparation: runtime.carePreparation, audit: runtime.aiAudit, privateMode: keepWordingAwaitedFor(runtime), privateModeHint: readKeepWordingOnDevice })
        : null,
    [runtime, aiAssistanceFactory, keepWordingAwaitedFor, readKeepWordingOnDevice],
  );
  /**
   * Packet 11C Addendum C (C2): the patient's choice applies at once (from the next explicit request; a request already past its mode
   * check is not altered) and is then persisted; a failed save keeps the choice for this session and the screen says storage failed.
   */
  const changeKeepWordingOnDevice = useCallback(
    async (next: boolean) => {
      keepWordingRef.current = next;
      setKeepWordingOnDevice(next);
      try {
        if (!runtime) throw new Error("STORAGE_UNAVAILABLE");
        await runtime.keepWordingOnDevice.persist(next);
        unsavedKeepWordingChoice.current = null;
      } catch (error) {
        // Fix round 1 (M-1): kept for this session, also across a reopen of the dataset.
        unsavedKeepWordingChoice.current = next;
        throw error;
      }
    },
    [runtime],
  );
  const historyExplainer: PatternExplainerPort | null = aiAssistance?.history ?? null;
  const careSummaryWording: CareSummaryAiWordingPort | null = aiAssistance?.careSummary ?? null;

  const current = stack[stack.length - 1]!;
  const isTopLevel = TOP_LEVEL_SCREENS.includes(current.screen);
  // HSA-bounded mode off only: care checks due (Today's care card and the More badge), reloaded as the visible screen changes.
  const careNudges = useCareNudgeSummary(runtime?.careOrganisation.query, current.screen);

  const navigate = useCallback((screen: ScreenId, params?: Record<string, string>) => {
    setStack((prev) => [...prev, { screen, params }]);
  }, []);

  const goBack = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const switchTab = useCallback((screen: ScreenId) => {
    setStack([{ screen }]);
  }, []);

  /** My medicines sub-views: add/directions push; list pops back to the list. */
  const showMedicinesView = useCallback((view: MyMedicinesView, medicineId?: string) => {
    setStack((prev) => {
      const entry: NavigationEntry = {
        screen: "MY_MEDICINES",
        params: medicineId ? { view, medicineId } : { view },
      };
      if (view === "list") {
        const index = prev.findLastIndex(
          (candidate) => candidate.screen === "MY_MEDICINES" && (candidate.params?.view ?? "list") === "list",
        );
        return index >= 0 ? prev.slice(0, index + 1) : [...prev.slice(0, -1), entry];
      }
      const top = prev[prev.length - 1];
      if (view === "directions" && top?.screen === "MY_MEDICINES" && top.params?.view === "add") {
        return [...prev.slice(0, -1), entry];
      }
      return [...prev, entry];
    });
  }, []);

  /** Persists a complete onboarding state from the journal side. */
  const saveOnboarding = useCallback(
    (next: DemoOnboardingStateV1) => {
      if (!repository) return { ok: false as const, reason: "STORAGE_UNAVAILABLE" as const };
      const result = repository.save({ ...next, updatedAt: new Date().toISOString() });
      if (result.ok) setOnboarding(result.state);
      return result;
    },
    [repository],
  );

  const finishOnboarding = useCallback((exit: OnboardingExit) => {
    // Packet 11C C7 finding D1: the finished setup's locale is the setup's own; a runtime that opens later never replaces it.
    onboardingLocaleRef.current = true;
    setOnboarding(exit.state);
    setPhase({ kind: "APP" });
    setStack(
      exit.destination === "TODAY"
        ? [{ screen: "TODAY" }]
        : [
            { screen: "TODAY" },
            {
              screen: "MY_MEDICINES",
              params: { view: exit.destination === "MY_MEDICINES_ADD" ? "add" : "list" },
            },
          ],
    );
  }, []);

  /** Prepares a snapshot from exactly what was ticked on Screen 10, then opens its preview. */
  const prepareSummary = useCallback(
    async (selection: CarePreparationSelection): Promise<boolean> => {
      if (!runtime) return false;
      const result = await runtime.carePreparation.commands.prepare({
        locale,
        period: selection.period,
        appointment: selection.appointment ? { recordType: "APPOINTMENT", recordId: selection.appointment.recordId, revisionId: selection.appointment.revisionId } : null,
        groups: selection.factGroups.map((group) => ({ key: group.key, sources: group.sources })),
        questions: selection.questions.map((question) => ({ recordType: "CARE_QUESTION", recordId: question.recordId, revisionId: question.revisionId })),
        notSelected: selection.notSelected,
      });
      if (result.kind !== "COMMITTED") return false;
      navigate("CARE_SUMMARY_PREVIEW", { recordId: result.recordId });
      return true;
    },
    [runtime, locale, navigate],
  );

  /**
   * Packet 11C B4b: an accepted AI-assisted replacement takes the superseded preview's place in the navigation stack. The screen
   * instance is kept (its key stays the first preview's id), so Back still returns to visit preparation, never to the superseded one.
   */
  const replacePreview = useCallback((recordId: RecordId) => {
    setStack((prev) => {
      const top = prev[prev.length - 1];
      if (top?.screen !== "CARE_SUMMARY_PREVIEW") return prev;
      return [...prev.slice(0, -1), { screen: "CARE_SUMMARY_PREVIEW", params: { recordId, previewKey: top.params?.previewKey ?? top.params?.recordId ?? "" } }];
    });
  }, []);

  const refreshToday = useCallback(async () => {
    if (!runtime) return;
    setToday(await runtime.query.loadToday());
  }, [runtime]);

  /**
   * Each local key is cleared by the repository that owns it
   * (JAGAON_LOCAL_STATE_KEYS). Every owner is attempted even when another
   * fails; the result is true only when all of them are gone.
   */
  const clearLocalStateOwners = useCallback(() => {
    // An owner that is not loaded yet is still attempted, never assumed clear.
    const onboardingOwner = repository ?? repositoryRef.current ?? onboardingRepositoryFactory();
    const results = [onboardingOwner.clear().ok, appointmentNotes.clear().ok];
    return results.every(Boolean);
  }, [appointmentNotes, repository, onboardingRepositoryFactory]);
  clearLocalStateOwnersRef.current = clearLocalStateOwners;

  const createDeleteAllPort = useCallback(
    () =>
      deleteAllPortFactory({
        databaseName: JAGAON_DATABASE_NAME,
        closeRuntime: () => {
          runtimeClosedByOperation.current = true;
          runtimeRef.current?.close();
          runtimeRef.current = null;
        },
        clearLocalState: () => {
          if (!clearLocalStateOwners()) throw new Error("STORAGE_UNAVAILABLE");
        },
      }),
    [deleteAllPortFactory, clearLocalStateOwners],
  );
  // The port is created on first use (an event), never during render.
  const deleteAllPort = useMemo<DeleteAllPort>(() => {
    let port: DeleteAllPort | null = null;
    const current = () => (port ??= createDeleteAllPort());
    return {
      prepare: () => current().prepare(),
      async confirm(plan, token, events) {
        runtimeClosedByOperation.current = false;
        const result = await current().confirm(plan, token, {
          onRequestIssued: () => {
            setDeletionInFlight({ waitingForTab: false });
            events?.onRequestIssued?.();
          },
          onBlocked: () => {
            setDeletionInFlight({ waitingForTab: true });
            events?.onBlocked?.();
          },
        });
        setDeletionInFlight(null);
        if (result.kind === "DELETED") onDatasetDeletedRef.current(result.localStateCleared);
        else if (runtimeClosedByOperation.current) reopenRuntime();
        return result;
      },
    };
  }, [createDeleteAllPort]);

  /** A destructive operation closed this tab's runtime but did not complete: reopen it. */
  function reopenRuntime() {
    runtimeClosedByOperation.current = false;
    setRuntime(null);
    setRuntimeEpoch((value) => value + 1);
  }

  /** Whole dataset deleted: restart setup on a new, unseeded local dataset (spec 6.8). */
  const onDatasetDeleted = useCallback((localStateCleared: boolean) => {
    // Corrective Pass C: incomplete cleanup is recorded durably in the replacement dataset.
    runtimeOptions.current = {
      seedSyntheticScenarioOnCreate: false,
      ...(localStateCleared ? {} : { localStateCleanup: { requestedAt: new Date().toISOString() as Instant, when: "ALWAYS" as const } }),
    };
    setRuntime(null);
    setStorageLock(null);
    setToday(EMPTY_TODAY);
    // Fix round 1 (M-1): every setting went with the dataset, including an unsaved "Keep wording on this device" choice (D11: off).
    unsavedKeepWordingChoice.current = null;
    onboardingLocaleRef.current = false;
    setOnboarding(null);
    // Preferences were deleted with the dataset: the neutral shell returns to en-SG.
    setLocale("en-SG");
    setStack([{ screen: "TODAY" }]);
    // "Local data deleted" only when no local key remains.
    setDatasetDeleted(localStateCleared);
    setPhase({ kind: "ONBOARDING", initial: null });
    setRuntimeEpoch((value) => value + 1);
  }, []);
  onDatasetDeletedRef.current = onDatasetDeleted;

  const createRestorePort = useCallback(
    () =>
      restorePortFactory({
        databaseName: JAGAON_DATABASE_NAME,
        closeRuntime: () => {
          runtimeClosedByOperation.current = true;
          runtimeRef.current?.close();
          runtimeRef.current = null;
        },
      }),
    [restorePortFactory],
  );
  const restorePort = useMemo<RestorePort>(() => {
    let port: RestorePort | null = null;
    const current = () => (port ??= createRestorePort());
    return {
      inspect: (file, passphrase) => current().inspect(file, passphrase),
      async confirm(plan, confirmation) {
        runtimeClosedByOperation.current = false;
        const result = await current().confirm(plan, confirmation);
        // A committed restore reopens through reconciliation; any other outcome restores normal use.
        if (result.kind !== "COMMITTED" && runtimeClosedByOperation.current) reopenRuntime();
        return result;
      },
    };
  }, [createRestorePort]);

  /** Re-open the restored dataset; the runtime resumes reconciliation before any use. */
  const awaitReconciliation = useCallback(
    () =>
      new Promise<"COMPLETED" | "LOCKED">((resolve) => {
        reconciliationWaiter.current = resolve;
        runtimeOptions.current = { bootstrapLocaleAfterRestore: locale };
        setRuntime(null);
        setStorageLock(null);
        setRuntimeEpoch((value) => value + 1);
      }),
    [locale],
  );

  const retryStorage = useCallback(() => {
    // "Try recovery again" is the explicit patient action that may resume a blocked restore.
    runtimeOptions.current = { ...runtimeOptions.current, resumeFailedRestore: storageLock?.kind === "RECOVERY_REQUIRED" };
    setStorageLock(null);
    setRuntime(null);
    setRuntimeEpoch((value) => value + 1);
  }, [storageLock]);

  // --- Screen rendering ---

  function renderScreen() {
    const entry = current;
    switch (entry.screen) {
      case "TODAY":
        return (
          <TodayScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            journal={today}
            actionsDisabled={!runtime}
            navigate={navigate}
            recordDeletion={runtime?.recordDeletion}
            onRecordDeleted={() => void refreshToday()}
            onOpenHistory={() => switchTab("HISTORY")}
            careNudges={careNudges}
          />
        );
      case "LOG_GLUCOSE":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <GlucoseEntryScreen
            messages={messages}
            locale={locale}
            commandService={runtime.commands}
            goBack={goBack}
            onCommitted={refreshToday}
          />
        );
      case "CHANGE_READING_TIME":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <ReadingTimeScreen
            messages={messages}
            locale={locale}
            goBack={goBack}
            recordId={(entry.params?.recordId ?? "") as RecordId}
            queryPort={runtime.query}
            commandService={runtime.commands}
            onCommitted={refreshToday}
          />
        );
      case "RECORD_INSULIN":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <InsulinEntryScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            commandService={runtime.commands}
            goBack={goBack}
            onCommitted={refreshToday}
          />
        );
      case "LOG_MEAL":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <MealEntryScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            commandService={runtime.commands}
            goBack={goBack}
            onCommitted={refreshToday}
          />
        );
      case "MEDICATION_INFORMATION":
        return (
          <MedicationInformationScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            goBack={goBack}
            addCareQuestion={
              runtime
                ? async (text) => {
                    // Owner decision 2026-10-14: the same save as "Add my own question" in Prepare for my appointment, linked to the
                    // next recorded appointment when there is one; it starts unticked there.
                    const visit = await runtime.careOrganisation.query.loadVisitPreparation();
                    const appointment = visit.status === "READY" ? visit.appointment : null;
                    const result = await runtime.careOrganisation.commands.createCareQuestion({
                      questionText: { text, language: "und" },
                      ...(appointment ? { relatedAppointment: { recordType: "APPOINTMENT", recordId: appointment.recordId, revisionId: appointment.revisionId } } : {}),
                    });
                    return result.kind === "COMMITTED";
                  }
                : undefined
            }
          />
        );
      case "NEARBY_FOOD":
        return (
          <NearbyFoodScreen
            messages={messages}
            locale={locale}
            goBack={goBack}
            navigate={navigate}
            initialAttribute={entry.params?.attribute}
          />
        );
      case "GENERAL_FOOD_INFORMATION":
        return (
          <FoodGeneralInfoScreen
            messages={messages}
            goBack={goBack}
          />
        );
      case "MORE":
        return (
          <MoreScreen
            messages={messages}
            navigate={navigate}
            locale={locale}
            setLocale={setLocale}
            persistLocale={async (nextLocale) => {
              if (!runtime) throw new Error("STORAGE_UNAVAILABLE");
              await runtime.persistLocale(nextLocale);
              if (onboarding && !saveOnboarding({ ...onboarding, locale: nextLocale }).ok) {
                throw new Error("STORAGE_UNAVAILABLE");
              }
            }}
            deleteAll={deleteAllPort}
            onDatasetDeleted={noop}
            keepWording={{ value: runtime ? keepWordingOnDevice : null, change: changeKeepWordingOnDevice }}
            systemSettings={
              devSettingsEnabled ? (
                <VoiceProviderSettingsSection locale={locale} probe={panelProbe} webSpeechSupported={webSpeechSupported} stored={voicePreference} onSelect={selectVoiceProvider} busy={voiceSessionActive} />
              ) : undefined
            }
          />
        );
      case "MY_MEDICINES":
        if (!onboarding) return <p role="status">{messages.shared.loading}</p>;
        return (
          <MyMedicinesScreen
            key={`${entry.params?.view ?? "list"}:${entry.params?.medicineId ?? ""}`}
            messages={messages}
            locale={locale}
            state={onboarding}
            view={(entry.params?.view as MyMedicinesView | undefined) ?? "list"}
            medicineId={entry.params?.medicineId}
            save={saveOnboarding}
            navigate={navigate}
            showView={showMedicinesView}
          />
        );
      case "HISTORY":
        return (
          <RecordedHistoryScreen
            messages={messages}
            locale={locale}
            history={runtime?.history ?? null}
            selection={appointmentNotes}
            explainer={historyExplainer}
            previewInsights={runtime?.previewInsights ?? null}
          />
        );
      case "MEDICATION_SCHEDULE":
        return (
          <MedicationScheduleScreen
            messages={messages}
            locale={locale}
            schedule={runtime?.medicationSchedule ?? null}
            medicationRecordIds={fixture.recordedPrescriptions.map((prescription) => prescription.medicationRecordId)}
          />
        );
      case "PREVENTIVE_CARE":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <PreventiveCareScreen
            messages={messages}
            locale={locale}
            query={runtime.careOrganisation.query}
            commands={runtime.careOrganisation.commands}
          />
        );
      case "CARE_PREPARATION":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <CarePreparationScreen
            messages={messages}
            locale={locale}
            query={runtime.careOrganisation.query}
            commands={runtime.careOrganisation.commands}
            onPreview={prepareSummary}
          />
        );
      case "CARE_SUMMARY_PREVIEW":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <CareSummaryPreviewScreen
            key={entry.params?.previewKey ?? entry.params?.recordId ?? ""}
            messages={messages}
            locale={locale}
            recordId={(entry.params?.recordId ?? "") as RecordId}
            query={runtime.carePreparation.query}
            commands={runtime.carePreparation.commands}
            print={printPort}
            onBack={goBack}
            aiWording={careSummaryWording}
            onReplaced={replacePreview}
          />
        );
      case "DATA_BACKUP":
        return (
          <DataBackupScreen
            messages={messages}
            view={(entry.params?.view as DataBackupView | undefined) ?? "hub"}
            showView={(view) => navigate("DATA_BACKUP", { view })}
            deleteAll={deleteAllPort}
            onDeleted={noop}
            createPanel={runtime ? <CreateBackupPanel messages={messages} locale={locale} port={runtime.backup} onDone={goBack} /> : undefined}
            restorePanel={
              <RestoreBackupPanel
                messages={messages}
                locale={locale}
                port={restorePort}
                awaitReconciliation={awaitReconciliation}
                onCreateBackup={() => navigate("DATA_BACKUP", { view: "create" })}
                onCancel={goBack}
                onOpenToday={() => switchTab("TODAY")}
              />
            }
          />
        );
      case "HELP_INFORMATION":
        return (
          <HelpScreen
            messages={messages}
            goBack={goBack}
          />
        );
      case "MY_NOTES":
        // Owner decision 2026-10-14 (My notes): the stored notes and the existing permanent deletion of one note.
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return <MyNotesScreen messages={messages} locale={locale} notes={runtime.notes ? { query: runtime.notes.query, deletion: runtime.recordDeletion } : undefined} />;
      case "TELL_JAGAON": {
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        const voice = runtime.voice;
        // Packet 13 (Q13-6, HELD by the integration gate until the re-review approves): one confirmed fact → the existing command.
        // Owner decision 2026-10-14 (Tell JagaOn understands more): a feeling saved as a note goes to the personal-note service, an
        // activity to the existing activity command.
        const saveFact = voice
          ? createVoiceJournalSave({
              commands: runtime.commands,
              recordMedicationEvent: voice.recordMedicationEvent,
              recordActivity: runtime.commands.recordActivity,
              notes: runtime.notes?.commands,
              now: () => new Date().toISOString() as never,
            })
          : null;
        return (
          <TellJagaOnScreen
            messages={messages}
            locale={locale}
            voiceAvailable={voice !== undefined}
            // Web Speech: the production provider choice, or the injected single-provider path (tests, harness).
            checkAvailability={legacyVoice ? legacyAvailability : undefined}
            resolveProvider={legacyVoice ? undefined : resolveVoiceProvider}
            loadTranscriber={legacyVoice ? loadLegacyTranscriber : loadProviderTranscriber}
            onSessionActivity={setVoiceSessionActive}
            terminology={voice?.terminology ?? UNAVAILABLE_TERMINOLOGY}
            glucoseEntryUnit="MMOL_PER_L"
            reportedAmountSaved
            // DeepSeek transcript extraction is offered only when its task is activated (never under the shipped manifest). No app-level
            // reader of the in-memory AI passcode exists yet, so an activated call would end UNAVAILABLE (PASSCODE_MISSING) and send nothing.
            remoteExtraction={isTranscriptExtractionActivated() ? createVoiceRemoteExtraction({ passcode: () => null }) : undefined}
            // Integration gate lifted 2026-10-09 after the extractor re-reviews and the targeted confirmation: one confirmed fact goes to
            // the existing journal command; the Today refresh never decides the save outcome (review I-3).
            onSaveFacts={saveFact ? createVoiceSaveWithRefresh(saveFact, refreshToday) : async () => ({ kind: "NOT_SAVED" as const })}
            // Finding N-1: a card or the chooser opens that existing entry screen blank (no parameters, nothing carried over); Back to Today
            // is a separate exit to the Today tab.
            onManualEntry={(kind) => navigate(kind === "GLUCOSE" ? "LOG_GLUCOSE" : kind === "MEAL" ? "LOG_MEAL" : "MEDICATION_SCHEDULE")}
            // Owner decision 2026-10-14 (design §3.1 steps 4–7): "Talk it through" opens the feelings chat; the note goes to the
            // personal-note service and her doctor question to the existing care-question command (linked to the next appointment).
            feelingsChat={runtime.notes ? { chat: feelingsChatPort, ...createFeelingsChatStorage({ notes: runtime.notes.commands, careOrganisation: runtime.careOrganisation }) } : undefined}
            // HSA preview (owner decision 2026-10-14): the medicine information card's "Open in My medicines".
            onOpenMyMedicines={() => navigate("MY_MEDICINES")}
            onClose={() => switchTab("TODAY")}
          />
        );
      }
      default:
        return null;
    }
  }

  // The demo boundary banner on the app's screens: only when `DEMO_BOUNDARY_PLACEMENT` is EVERY_SCREEN (owner decision 2026-10-12: hidden).
  const everyScreenBoundary = DEMO_BOUNDARY_PLACEMENT === "EVERY_SCREEN" ? <DemoBoundaryNotice /> : null;

  // --- Release profile guard ---
  if (CURRENT_RELEASE_PROFILE !== "HACKATHON_DEMO") {
    return (
      <>
        <DemoBoundaryNotice />
        <main className="app-main">
          <h1 className="app-title">{messages.shared.appName}</h1>
          <p className="app-status">{messages.shared.demoBoundary}</p>
        </main>
      </>
    );
  }

  if (deletionInFlight) {
    return (
      <>
        {everyScreenBoundary}
        <main className="app-main">
          <DeletionInProgress messages={messages} waitingForTab={deletionInFlight.waitingForTab} />
        </main>
      </>
    );
  }

  if (lockRestoreOpen) {
    // Restore offered from the recovery shell (frames 09 and 12) without a runtime.
    return (
      <>
        {everyScreenBoundary}
        <main className="app-main app-main--child">
          <RestoreBackupPanel
            messages={messages}
            locale={locale}
            port={restorePort}
            awaitReconciliation={awaitReconciliation}
            onCancel={() => setLockRestoreOpen(false)}
            onOpenToday={() => {
              setLockRestoreOpen(false);
              setStack([{ screen: "TODAY" }]);
            }}
          />
        </main>
      </>
    );
  }

  if (storageLock) {
    return (
      <>
        {everyScreenBoundary}
        <main className="app-main app-main--child">
          <IntegrityShell
            messages={messages}
            lock={storageLock}
            onRetry={retryStorage}
            onRestore={() => setLockRestoreOpen(true)}
            deleteAll={deleteAllPort}
            onDeleted={noop}
          />
        </main>
      </>
    );
  }

  if (phase.kind === "LOADING") {
    return (
      <>
        {everyScreenBoundary}
        <main className="app-main">
          <p role="status">{messages.shared.loading}</p>
        </main>
      </>
    );
  }

  if (phase.kind === "ONBOARDING" && repository) {
    // Bottom navigation stays hidden until setup is completed or skipped.
    return (
      <>
      {datasetDeleted ? (
        <div className="app-main">
          <Banner variant="success">{messages.packet10.deletion.deleteAllDone}</Banner>
        </div>
      ) : null}
      <OnboardingFlow
        key={phase.initial?.updatedAt ?? "fresh"}
        messages={messages}
        locale={locale}
        onLocaleChange={(next) => {
          // Packet 11C C7 finding D1: a language chosen during setup is the setup's own; a runtime that opens meanwhile keeps it.
          onboardingLocaleRef.current = true;
          setLocale(next);
        }}
        repository={repository}
        initialState={phase.initial}
        onExit={(exit) => {
          setDatasetDeleted(false);
          finishOnboarding(exit);
        }}
      />
      </>
    );
  }

  return (
    <>
      {everyScreenBoundary}
      <AppShell
        messages={messages}
        currentScreen={current.screen}
        isTopLevel={isTopLevel}
        onBack={goBack}
        onSwitchTab={switchTab}
      >
        {renderScreen()}
      </AppShell>
    </>
  );
}

// Re-export for tests
export type { AppMessages };
