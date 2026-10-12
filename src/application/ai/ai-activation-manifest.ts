import { deepFreeze } from "@/application/deep-freeze";
import { AI_TASK_TYPES, type AiTaskType } from "@/domain/ai";

/**
 * Packet 11A compile-time AI activation (Packet 11 design Section 3). Registration
 * is not remote activation: every task was `DETERMINISTIC_ONLY` in 11A. Remote
 * processing is default-denied unless the profile is exactly `HACKATHON_DEMO`
 * and the task is `SYNTHETIC_REMOTE_ENABLED`; no other profile inherits it.
 *
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12;
 * `ai-activation.11c.1`): under `HACKATHON_DEMO`, `EXPLAIN_PATTERN` and
 * `DRAFT_CARE_PREPARATION_SUMMARY` are `SYNTHETIC_REMOTE_ENABLED`; the four other
 * tasks stay `DETERMINISTIC_ONLY`. Enabling a task does not send anything on its
 * own: a request still needs the server switch `JAGAON_REMOTE_AI`, the route's
 * origin, access and spend checks, a QUALIFIED request class (only the six en-SG
 * classes; every zh-SG class is PENDING), the per-request disclosure and the
 * "Keep wording on this device" setting off; anything else gets the standard
 * (deterministic) wording.
 */

export const AI_ACTIVATION_STATES = Object.freeze(["REGISTERED_DISABLED", "DETERMINISTIC_ONLY", "SYNTHETIC_REMOTE_ENABLED"] as const);
export type AiTaskActivationState = (typeof AI_ACTIVATION_STATES)[number];

export type AiActivationManifest = Readonly<{
  manifestVersion: string;
  profile: "HACKATHON_DEMO";
  tasks: Readonly<Record<AiTaskType, AiTaskActivationState>>;
}>;

export const AI_ACTIVATION_MANIFEST: AiActivationManifest = deepFreeze({
  manifestVersion: "ai-activation.11c.1",
  profile: "HACKATHON_DEMO",
  // Every task named (a missing task fails the type check); exactly the two owner-approved tasks are remote-enabled (decision A).
  tasks: {
    EXTRACT_CANDIDATE_FACTS: "DETERMINISTIC_ONLY",
    EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED",
    DRAFT_NEUTRAL_INQUIRY: "DETERMINISTIC_ONLY",
    ANSWER_BOUNDED_RECORD_QUERY: "DETERMINISTIC_ONLY",
    DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED",
    PHRASE_NON_CLINICAL_RESPONSE: "DETERMINISTIC_ONLY",
  } satisfies Record<AiTaskType, AiTaskActivationState>,
});

/**
 * The pre-activation manifest (`ai-activation.11a.1`: every task DETERMINISTIC_ONLY under HACKATHON_DEMO), kept as a production-safe
 * constant. Packet 11C English activation (owner decisions Q and A, I-8 review follow-up): it is the DEFAULT of the legacy 11A task
 * service (`createAiTaskService`, which sends a detached payload with record values, not a value-blind request), so that service never
 * inherits the activation of the hybrid shell path; only an explicitly injected manifest (the offline evaluation harness, tests) can
 * enable a task there.
 */
export const AI_DETERMINISTIC_ONLY_MANIFEST: AiActivationManifest = deepFreeze({
  manifestVersion: "ai-activation.11a.1",
  profile: "HACKATHON_DEMO",
  tasks: Object.fromEntries(AI_TASK_TYPES.map((taskType) => [taskType, "DETERMINISTIC_ONLY"])) as Record<AiTaskType, AiTaskActivationState>,
});

export type AiTaskActivation =
  | { state: "SYNTHETIC_REMOTE_ENABLED" }
  | { state: "DETERMINISTIC_ONLY" | "REGISTERED_DISABLED"; reason: "TASK_DISABLED" | "PROFILE_NOT_PERMITTED" };

export function resolveAiTaskActivation(taskType: AiTaskType, profile: unknown, manifest: AiActivationManifest = AI_ACTIVATION_MANIFEST): AiTaskActivation {
  if (!(AI_TASK_TYPES as readonly string[]).includes(taskType)) throw new Error("UNKNOWN_AI_TASK");
  const state = manifest.tasks[taskType];
  if (state === "REGISTERED_DISABLED") return { state, reason: "TASK_DISABLED" };
  if (profile !== "HACKATHON_DEMO" || manifest.profile !== "HACKATHON_DEMO") return { state: "DETERMINISTIC_ONLY", reason: "PROFILE_NOT_PERMITTED" };
  if (state === "SYNTHETIC_REMOTE_ENABLED") return { state };
  return { state: "DETERMINISTIC_ONLY", reason: "TASK_DISABLED" };
}
