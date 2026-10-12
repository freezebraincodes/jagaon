import { describe, expect, it } from "vitest";
import { AI_TASK_TYPES } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST, AI_ACTIVATION_STATES, resolveAiTaskActivation } from "./ai-activation-manifest";

/**
 * Packet 11A Task 2: closed activation; remote processing default-denied.
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12; `ai-activation.11c.1`): under HACKATHON_DEMO exactly
 * EXPLAIN_PATTERN and DRAFT_CARE_PREPARATION_SUMMARY are SYNTHETIC_REMOTE_ENABLED; the four other tasks stay DETERMINISTIC_ONLY.
 */
const REMOTE_ENABLED = ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const;

describe("AI activation manifest", () => {
  it("uses exactly the three closed activation states", () => {
    expect([...AI_ACTIVATION_STATES]).toEqual(["REGISTERED_DISABLED", "DETERMINISTIC_ONLY", "SYNTHETIC_REMOTE_ENABLED"]);
  });

  it("has one entry per registered task, for the exact HACKATHON_DEMO profile: the two owner-approved tasks remote-enabled, every other task deterministic-only", () => {
    expect(AI_ACTIVATION_MANIFEST.profile).toBe("HACKATHON_DEMO");
    expect(Object.keys(AI_ACTIVATION_MANIFEST.tasks).sort()).toEqual([...AI_TASK_TYPES].sort());
    for (const taskType of AI_TASK_TYPES) {
      expect(AI_ACTIVATION_MANIFEST.tasks[taskType], taskType).toBe((REMOTE_ENABLED as readonly string[]).includes(taskType) ? "SYNTHETIC_REMOTE_ENABLED" : "DETERMINISTIC_ONLY");
    }
    expect(Object.isFrozen(AI_ACTIVATION_MANIFEST)).toBe(true);
    expect(Object.isFrozen(AI_ACTIVATION_MANIFEST.tasks)).toBe(true);
  });

  it("resolves remote processing only for the two enabled tasks under HACKATHON_DEMO, and never for any other profile", () => {
    for (const taskType of AI_TASK_TYPES) {
      expect(resolveAiTaskActivation(taskType, "HACKATHON_DEMO"), taskType).toEqual(
        (REMOTE_ENABLED as readonly string[]).includes(taskType) ? { state: "SYNTHETIC_REMOTE_ENABLED" } : { state: "DETERMINISTIC_ONLY", reason: "TASK_DISABLED" },
      );
      for (const profile of ["PATIENT_RELEASE", "IMPLEMENTATION_CHECKPOINT", "hackathon_demo", "", undefined, null, 7]) {
        expect(resolveAiTaskActivation(taskType, profile).state, `${taskType} ${String(profile)}`).toBe("DETERMINISTIC_ONLY");
      }
    }
  });

  it("default-denies a non-demo, unknown or malformed profile even when the manifest would permit remote use", () => {
    const remote = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" as const } };
    expect(resolveAiTaskActivation("EXPLAIN_PATTERN", "HACKATHON_DEMO", remote)).toEqual({ state: "SYNTHETIC_REMOTE_ENABLED" });
    for (const profile of ["PATIENT_RELEASE", "IMPLEMENTATION_CHECKPOINT", "hackathon_demo", "", undefined, null, 7]) {
      expect(resolveAiTaskActivation("EXPLAIN_PATTERN", profile, remote)).toEqual({ state: "DETERMINISTIC_ONLY", reason: "PROFILE_NOT_PERMITTED" });
    }
  });

  it("Packet 11C English activation (owner decisions Q and A): exactly EXPLAIN_PATTERN and DRAFT_CARE_PREPARATION_SUMMARY are SYNTHETIC_REMOTE_ENABLED under HACKATHON_DEMO", () => {
    expect(AI_ACTIVATION_MANIFEST).toEqual({
      manifestVersion: "ai-activation.11c.1",
      profile: "HACKATHON_DEMO",
      tasks: {
        EXTRACT_CANDIDATE_FACTS: "DETERMINISTIC_ONLY",
        EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED",
        DRAFT_NEUTRAL_INQUIRY: "DETERMINISTIC_ONLY",
        ANSWER_BOUNDED_RECORD_QUERY: "DETERMINISTIC_ONLY",
        DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED",
        PHRASE_NON_CLINICAL_RESPONSE: "DETERMINISTIC_ONLY",
      },
    });
    expect(Object.entries(AI_ACTIVATION_MANIFEST.tasks).filter(([, state]) => state === "SYNTHETIC_REMOTE_ENABLED").map(([taskType]) => taskType)).toEqual([...REMOTE_ENABLED]);
    expect(Object.values(AI_ACTIVATION_MANIFEST.tasks).filter((state) => state === "REGISTERED_DISABLED")).toEqual([]);
    // The two surfaces Checkpoint 2 prepared (source-backed explanation, appointment preparation) are the two enabled tasks.
    for (const taskType of REMOTE_ENABLED) expect(resolveAiTaskActivation(taskType, "HACKATHON_DEMO")).toEqual({ state: "SYNTHETIC_REMOTE_ENABLED" });
  });

  it("keeps a disabled task disabled and rejects an unknown task", () => {
    const disabled = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, PHRASE_NON_CLINICAL_RESPONSE: "REGISTERED_DISABLED" as const } };
    expect(resolveAiTaskActivation("PHRASE_NON_CLINICAL_RESPONSE", "HACKATHON_DEMO", disabled)).toEqual({ state: "REGISTERED_DISABLED", reason: "TASK_DISABLED" });
    expect(() => resolveAiTaskActivation("CHAT" as never, "HACKATHON_DEMO")).toThrow("UNKNOWN_AI_TASK");
  });
});
