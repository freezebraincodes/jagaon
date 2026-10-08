import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import type { Instant } from "@/domain/shared/time";
import type { RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "./ai-activation-manifest";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import type { AiInvocationAuditPort } from "./ai-provider-port";
import { createBrowserShellClient, INTERIM_FAIL_CLOSED_DISCLOSURE, type AiRemoteUseDisclosure, type BrowserShellFetcher } from "./browser-shell-client";
import { createPatternExplainer } from "./explain-pattern";

/**
 * Packet 11C Addendum B, Task B2b: the browser wiring of the Recorded-history explanation (B-boundary, D1). The app calls this once per
 * opened dataset runtime and passes the result to the history screen, so the explainer keeps one identity for the runtime's lifetime.
 *
 * It builds exactly ONE hybrid task service (the shipped activation manifest, the browser shell client behind the interim fail-closed
 * disclosure, the runtime's local AI audit port) and ONE pattern explainer over the runtime's history query. Constructing it reads,
 * writes and sends nothing. Work happens only when the patient explicitly asks how a comparison was worked out (`explain`): each such
 * request writes one local audit row. With the shipped manifest every explanation is composed deterministically in the browser, nothing
 * is sent, no disclosure is asked and the result carries no AI source.
 *
 * Only the history and audit ports are passed by the shipped app. The other dependencies are test seams (an injected test manifest, a
 * test-only disclosure, a fake fetcher, a fixed clock); Task B3 replaces the interim disclosure with the real one.
 */
export type BrowserHistoryExplainerDependencies = Readonly<{
  history: RecordedHistoryQueryPort;
  audit: AiInvocationAuditPort;
  manifest?: AiActivationManifest;
  disclosure?: AiRemoteUseDisclosure;
  fetcher?: BrowserShellFetcher;
  now?: () => Instant;
  monotonicMs?: () => number;
  requestId?: () => string;
  online?: () => boolean;
}>;

const deviceNow = () => new Date().toISOString() as Instant;
const deviceMonotonicMs = () => performance.now();
const newRequestId = () => crypto.randomUUID();
const browserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function createBrowserHistoryExplainer(dependencies: BrowserHistoryExplainerDependencies): ReturnType<typeof createPatternExplainer> {
  const now = dependencies.now ?? deviceNow;
  const service = createAiHybridTaskService({
    releaseProfile: CURRENT_RELEASE_PROFILE,
    audit: dependencies.audit,
    now,
    monotonicMs: dependencies.monotonicMs ?? deviceMonotonicMs,
    manifest: dependencies.manifest ?? AI_ACTIVATION_MANIFEST,
    provider: createBrowserShellClient({ disclosure: dependencies.disclosure ?? INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher: dependencies.fetcher }),
    online: dependencies.online ?? browserOnline,
  });
  return createPatternExplainer({ history: dependencies.history, execute: service.execute, now, requestId: dependencies.requestId ?? newRequestId });
}
