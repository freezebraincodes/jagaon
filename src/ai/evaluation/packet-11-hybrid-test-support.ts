import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { planSlots } from "@/application/ai/language/slot-planner";
import { remoteTokenInventory, SHELL_OUTPUT_VERSIONS, type AiTaskRequest, type AtomTable, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { PACKET_11_FIXTURES } from "./packet-11-fixtures";

export function asHybridRequest(request: AiTaskRequest): AiTaskRequest {
  const task = request.taskType as "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY";
  return { ...structuredClone(request), runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES[task].bundleKey } as AiTaskRequest;
}
export function plannedFixture(fixtureId: string): { request: AiTaskRequest; plan: SlotPlan; atoms: AtomTable } {
  const fixture = PACKET_11_FIXTURES.find((entry) => entry.id === fixtureId);
  if (!fixture) throw new Error(`UNKNOWN_FIXTURE ${fixtureId}`);
  const request = asHybridRequest(fixture.request);
  const result = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType]);
  if (result.kind !== "PLANNED") throw new Error(`UNPLANNABLE ${fixtureId}`);
  return { request, plan: result.plan, atoms: result.atoms };
}
export function shellCandidate(plan: SlotPlan, texts: ShellTexts): Record<string, unknown> {
  const text = (path: string) => texts.get(path as never) ?? "";
  const shells = plan.taskType === "EXPLAIN_PATTERN"
    ? { headline: text("headline"), evidence: text("evidence") }
    : { sections: plan.sections.map((section) => ({ sectionSlot: section.sectionSlot, intro: text(section.introPath), bullets: section.bulletPaths.map(text) })) };
  // 11b.7: the output echoes the plan's slot plan version and token inventory (required slots in plan field order).
  // Observation ownership (@11b.8): the EXPLAIN shells are the model's fields only (headline, evidence) and the inventory is the
  // remote inventory; any observation text in `texts` is ignored (the application composes the observation).
  return { schemaVersion: SHELL_OUTPUT_VERSIONS[plan.taskType], slotPlanVersion: plan.planVersion, tokenInventory: remoteTokenInventory(plan), taskType: plan.taskType, locale: plan.locale, outcome: "SUCCESS", abstentionReason: null, shells };
}
