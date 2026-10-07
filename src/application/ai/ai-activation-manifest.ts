import { deepFreeze } from "@/application/deep-freeze";
import { AI_TASK_TYPES, type AiTaskType } from "@/domain/ai";

/**
 * Packet 11A compile-time AI activation (Packet 11 design Section 3). Registration
 * is not remote activation: every task is `DETERMINISTIC_ONLY` in 11A. Remote
 * processing is default-denied unless the profile is exactly `HACKATHON_DEMO`
 * and the task is `SYNTHETIC_REMOTE_ENABLED`; no other profile inherits it.
 */

export const AI_ACTIVATION_STATES = Object.freeze(["REGISTERED_DISABLED", "DETERMINISTIC_ONLY", "SYNTHETIC_REMOTE_ENABLED"] as const);
export type AiTaskActivationState = (typeof AI_ACTIVATION_STATES)[number];

export type AiActivationManifest = Readonly<{
  manifestVersion: string;
  profile: "HACKATHON_DEMO";
  tasks: Readonly<Record<AiTaskType, AiTaskActivationState>>;
}>;

export const AI_ACTIVATION_MANIFEST: AiActivationManifest = deepFreeze({
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
