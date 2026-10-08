import { describe, expect, it } from "vitest";
import { AI_TASK_TYPES } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST, AI_ACTIVATION_STATES, resolveAiTaskActivation } from "./ai-activation-manifest";

/** Packet 11A Task 2: closed activation; every task deterministic-only and remote processing default-denied. */

describe("AI activation manifest", () => {
  it("uses exactly the three closed activation states", () => {
    expect([...AI_ACTIVATION_STATES]).toEqual(["REGISTERED_DISABLED", "DETERMINISTIC_ONLY", "SYNTHETIC_REMOTE_ENABLED"]);
  });

  it("has one entry per registered task, for the exact HACKATHON_DEMO profile, all deterministic-only in 11A", () => {
    expect(AI_ACTIVATION_MANIFEST.profile).toBe("HACKATHON_DEMO");
    expect(Object.keys(AI_ACTIVATION_MANIFEST.tasks).sort()).toEqual([...AI_TASK_TYPES].sort());
    for (const taskType of AI_TASK_TYPES) expect(AI_ACTIVATION_MANIFEST.tasks[taskType]).toBe("DETERMINISTIC_ONLY");
    expect(Object.isFrozen(AI_ACTIVATION_MANIFEST)).toBe(true);
    expect(Object.isFrozen(AI_ACTIVATION_MANIFEST.tasks)).toBe(true);
  });

  it("never resolves remote processing in 11A, for any profile", () => {
    for (const taskType of AI_TASK_TYPES) {
      expect(resolveAiTaskActivation(taskType, "HACKATHON_DEMO")).toEqual({ state: "DETERMINISTIC_ONLY", reason: "TASK_DISABLED" });
    }
  });

  it("default-denies a non-demo, unknown or malformed profile even when the manifest would permit remote use", () => {
    const remote = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" as const } };
    expect(resolveAiTaskActivation("EXPLAIN_PATTERN", "HACKATHON_DEMO", remote)).toEqual({ state: "SYNTHETIC_REMOTE_ENABLED" });
    for (const profile of ["PATIENT_RELEASE", "IMPLEMENTATION_CHECKPOINT", "hackathon_demo", "", undefined, null, 7]) {
      expect(resolveAiTaskActivation("EXPLAIN_PATTERN", profile, remote)).toEqual({ state: "DETERMINISTIC_ONLY", reason: "PROFILE_NOT_PERMITTED" });
    }
  });

  it("Packet 11C Checkpoint 2 leaves every task state unchanged: DETERMINISTIC_ONLY under HACKATHON_DEMO, none SYNTHETIC_REMOTE_ENABLED", () => {
    expect(AI_ACTIVATION_MANIFEST).toEqual({
      manifestVersion: "ai-activation.11a.1",
      profile: "HACKATHON_DEMO",
      tasks: {
        EXTRACT_CANDIDATE_FACTS: "DETERMINISTIC_ONLY",
        EXPLAIN_PATTERN: "DETERMINISTIC_ONLY",
        DRAFT_NEUTRAL_INQUIRY: "DETERMINISTIC_ONLY",
        ANSWER_BOUNDED_RECORD_QUERY: "DETERMINISTIC_ONLY",
        DRAFT_CARE_PREPARATION_SUMMARY: "DETERMINISTIC_ONLY",
        PHRASE_NON_CLINICAL_RESPONSE: "DETERMINISTIC_ONLY",
      },
    });
    expect(Object.values(AI_ACTIVATION_MANIFEST.tasks).filter((state) => state === "SYNTHETIC_REMOTE_ENABLED")).toEqual([]);
    // The two surfaces Checkpoint 2 prepares (source-backed explanation, appointment preparation) stay deterministic-only.
    for (const taskType of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      expect(resolveAiTaskActivation(taskType, "HACKATHON_DEMO")).toEqual({ state: "DETERMINISTIC_ONLY", reason: "TASK_DISABLED" });
    }
  });

  it("keeps a disabled task disabled and rejects an unknown task", () => {
    const disabled = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, PHRASE_NON_CLINICAL_RESPONSE: "REGISTERED_DISABLED" as const } };
    expect(resolveAiTaskActivation("PHRASE_NON_CLINICAL_RESPONSE", "HACKATHON_DEMO", disabled)).toEqual({ state: "REGISTERED_DISABLED", reason: "TASK_DISABLED" });
    expect(() => resolveAiTaskActivation("CHAT" as never, "HACKATHON_DEMO")).toThrow("UNKNOWN_AI_TASK");
  });
});
