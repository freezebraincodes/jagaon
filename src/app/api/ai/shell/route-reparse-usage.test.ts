// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { plannedFixture } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { aiShellRouteResponseSchema } from "@/application/ai/ai-shell-route-contract";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";
import { createAiShellHandler } from "./ai-shell-handler";

/**
 * Packet 11C Addendum C, Task C5: "the route forwards usage for every potentially billed FAILED, including a completed call whose
 * candidate later fails re-parse". The re-parse after the server shell gates accepted a candidate cannot fail with the real gates (they
 * parse the same shell schema), so this file alone replaces the gate with one that accepts anything, to reach that path offline.
 */
vi.mock("@/application/ai/language/shell-validator", async (original) => ({
  ...(await original<typeof import("@/application/ai/language/shell-validator")>()),
  validateShellCandidate: () => ({ kind: "ACCEPTED", shells: new Map() }),
}));

const ENABLED: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };
const envelope = (text: string) => ({
  id: "resp_1", object: "response", status: "completed", model: "deepseek-flash",
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 600, output_tokens: 80 }, store: false, error: null, incomplete_details: null,
});

describe("a completed call whose accepted candidate fails the route's re-parse (C5)", () => {
  it("is FAILED with the call's reported usage, never without it", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope(JSON.stringify({ not: "a shell" }))), { status: 200, headers: { "content-type": "application/json" } }));
    // Packet 11C Addendum C (C1): a remote path needs a QUALIFIED class (test-only records; the shipped records are all PENDING).
    const handler = createAiShellHandler({ environment: { DEEPSEEK_API_KEY: "deepseek-SENTINEL-reparse" }, activationManifest: ENABLED, fetcher, requestClassGate: qualifiedTestRequestClassGate() });
    const request = projectShellTaskRequest(plannedFixture("p11.explain-pattern.en-sg.ordinary").plan);
    const response = await handler(new Request("http://localhost/api/ai/shell", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }));
    const body = await response.json();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { inputTokens: 600, outputTokens: 80, costMicroUsd: deepSeekCostMicroUsd(600, 80), basis: "REPORTED" } });
    expect(aiShellRouteResponseSchema.safeParse(body).success).toBe(true);
  });
});
