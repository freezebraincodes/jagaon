import { describe, expect, it, vi } from "vitest";
import { FALLBACK_QUESTIONS } from "@/domain/feelings-chat/feelings-chat-bank";
import type { FeelingsChatRequest } from "@/domain/feelings-chat/feelings-chat-contract";
import { createFeelingsChatClient } from "./feelings-chat-client";
import { createFakeFeelingsChatPort } from "./feelings-chat-fake-port";

/**
 * Tell JagaOn understands more (design §3.3): the browser client of /api/ai/feelings with a fake fetcher (no network, no live call), and
 * the pure fake port. Synthetic text only.
 */

const FIRST = "Feeling tired and a bit worried today.";
const turn = (n: number, messages: FeelingsChatRequest["messages"] = [{ role: "patient", text: FIRST }]): FeelingsChatRequest => ({ task: "FEELINGS_CHAT_TURN", turn: n, maxTurns: 3, messages });
const QUESTION = { kind: "QUESTION", question: "What has been making you feel tired lately?", summary: null, doctorQuestion: null, themes: [], end: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(respond: (input: string, init: RequestInit) => Response | Promise<Response>, options: { passcode?: () => string | null; timeoutMs?: number } = {}) {
  const calls: { input: string; init: RequestInit }[] = [];
  const instance = createFeelingsChatClient({ fetcher: async (input, init) => (calls.push({ input, init }), respond(input, init)), ...options });
  return { instance, calls };
}

describe("feelings-chat client", () => {
  it("OK: posts once to the same-origin route with only the request, validates again on the device, and returns AI_VALIDATED", async () => {
    const { instance, calls } = client(() => json({ kind: "OK", reply: QUESTION }), { passcode: () => "synthetic-pass-01" });
    expect(await instance.nextTurn(turn(1))).toEqual({ source: "AI_VALIDATED", reply: QUESTION });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("/api/ai/feelings");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(turn(1));
    expect((calls[0]!.init.headers as Record<string, string>)["x-jagaon-demo-passcode"]).toBe("synthetic-pass-01");
  });

  it.each<[string, () => Response | Promise<Response>, string]>([
    ["the network failing (offline)", () => Promise.reject(new TypeError("Failed to fetch")), "OFFLINE"],
    ["the AI switched off", () => json({ kind: "UNAVAILABLE", reason: "DISABLED" }, 403), "DISABLED"],
    ["the daily spend limit used up", () => json({ kind: "UNAVAILABLE", reason: "SPEND_CEILING_REACHED" }, 403), "SPEND_CEILING_REACHED"],
    ["the provider credit used up", () => json({ kind: "UNAVAILABLE", reason: "OPERATIONAL_SPEND_LOCKED" }), "OPERATIONAL_SPEND_LOCKED"],
    ["rate limited", () => json({ kind: "UNAVAILABLE", reason: "RATE_LIMITED" }), "RATE_LIMITED"],
    ["an upstream error", () => json({ kind: "UNAVAILABLE", reason: "UPSTREAM_ERROR" }), "UPSTREAM_ERROR"],
    ["the server's validator rejecting", () => json({ kind: "REJECTED", reasons: ["ADVICE"] }), "REJECTED_BY_SERVER"],
    ["a non-JSON body", () => new Response("<html>oops</html>", { status: 502 }), "RESPONSE_INVALID"],
    ["an unexpected shape", () => json({ kind: "OK", reply: { ...QUESTION, extra: true } }), "RESPONSE_INVALID"],
    // A reply the server let through but the device's rules reject (defence in depth).
    ["an OK reply with advice", () => json({ kind: "OK", reply: { ...QUESTION, question: "Why don't you rest more?" } }), "REJECTED_ON_DEVICE"],
  ])("%s → the turn's bank question (%s)", async (_name, respond, reason) => {
    const { instance } = client(respond);
    expect(await instance.nextTurn(turn(1))).toEqual({ source: "REVIEWED_BANK", reason, reply: { kind: "QUESTION", question: FALLBACK_QUESTIONS[0], summary: null, doctorQuestion: null, themes: [], end: false } });
    const second = turn(2, [{ role: "patient", text: FIRST }, { role: "jagaon_question", text: FALLBACK_QUESTIONS[0]! }, { role: "patient", text: "Work." }]);
    expect((await instance.nextTurn(second)).reply.question).toBe(FALLBACK_QUESTIONS[1]);
  });

  it("at the wrap-up turn, a failure gives the local wrap-up: her first words, no doctor question, no theme", async () => {
    const { instance } = client(() => json({ kind: "UNAVAILABLE", reason: "TIMEOUT" }));
    expect(await instance.nextTurn(turn(3))).toEqual({ source: "REVIEWED_BANK", reason: "TIMEOUT", reply: { kind: "WRAP_UP", question: null, summary: FIRST, doctorQuestion: null, themes: [], end: true } });
  });

  it("an invalid request is never sent", async () => {
    const { instance, calls } = client(() => json({ kind: "OK", reply: QUESTION }));
    const bad = { ...turn(1), messages: [{ role: "patient", text: FIRST, reading: 7.2 }] } as unknown as FeelingsChatRequest;
    expect(await instance.nextTurn(bad)).toMatchObject({ source: "REVIEWED_BANK", reason: "REQUEST_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("times out on its own and falls back (TIMEOUT); a cancelled turn falls back (CANCELLED)", async () => {
    const hanging = (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const { instance } = client(hanging, { timeoutMs: 10 });
    expect(await instance.nextTurn(turn(1))).toMatchObject({ source: "REVIEWED_BANK", reason: "TIMEOUT" });
    const { instance: other } = client(hanging);
    const controller = new AbortController();
    const pending = other.nextTurn(turn(1), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ source: "REVIEWED_BANK", reason: "CANCELLED" });
  });

  it("counts interventions as numbers only", async () => {
    const replies = [
      () => json({ kind: "OK", reply: QUESTION }),
      () => json({ kind: "REJECTED", reasons: ["DIAGNOSIS"] }),
      () => json({ kind: "OK", reply: { ...QUESTION, question: "You should rest more?" } }),
      () => json({ kind: "UNAVAILABLE", reason: "DISABLED" }),
      () => Promise.reject(new TypeError("offline")),
    ];
    let index = 0;
    const { instance } = client(() => replies[index++]!());
    for (let call = 0; call < replies.length; call += 1) await instance.nextTurn(turn(1));
    expect(instance.interventions()).toEqual({ requests: 5, aiAccepted: 1, rejectedByServer: 1, rejectedOnDevice: 1, unavailable: 2, doctorQuestionsDropped: 0, rulesSteppedIn: 2 });
  });

  describe("owner decision 2026-10-14: a doctor question that alone fails the rules is dropped and the summary kept", () => {
    const wrapRequest = turn(3, [{ role: "patient", text: FIRST }, { role: "jagaon_question", text: "What has been keeping you up?" }, { role: "patient", text: "Only sleeping 4 hours." }]);
    const summary = "Feeling tired; sleeping about 4 hours.";
    const wrapUp = (doctorQuestion: string | null) => ({ kind: "WRAP_UP", question: null, summary, doctorQuestion, themes: ["SLEEP"], end: true });

    it("the server dropped it: AI_VALIDATED with the summary and the server's reasons", async () => {
      const { instance } = client(() => json({ kind: "OK", reply: wrapUp(null), doctorQuestionDropped: ["MEDICINE_ACTION"] }));
      expect(await instance.nextTurn(wrapRequest)).toEqual({ source: "AI_VALIDATED", reply: wrapUp(null), doctorQuestionDropped: ["MEDICINE_ACTION"] });
      expect(instance.interventions()).toMatchObject({ aiAccepted: 1, doctorQuestionsDropped: 1, rulesSteppedIn: 1 });
    });

    it("the device drops it with the same rules (e.g. \"Should I reduce my insulin before bed?\"): summary kept, doctor question null", async () => {
      const { instance } = client(() => json({ kind: "OK", reply: wrapUp("Should I reduce my insulin before bed?") }));
      expect(await instance.nextTurn(wrapRequest)).toEqual({ source: "AI_VALIDATED", reply: wrapUp(null), doctorQuestionDropped: ["MEDICINE_ACTION", "DOCTOR_QUESTION_NOT_OWN_WORDS"] });
    });

    it("the fake port applies the same rule", async () => {
      const port = createFakeFeelingsChatPort([{ candidate: wrapUp("Should I reduce my insulin before bed?") }]);
      expect(await port.nextTurn(wrapRequest)).toMatchObject({ source: "AI_VALIDATED", reply: { summary, doctorQuestion: null }, doctorQuestionDropped: ["MEDICINE_ACTION", "DOCTOR_QUESTION_NOT_OWN_WORDS"] });
      expect(port.interventions()).toMatchObject({ doctorQuestionsDropped: 1, rulesSteppedIn: 1 });
    });

    it("a route OK carrying an unknown dropped reason is an unexpected shape", async () => {
      const { instance } = client(() => json({ kind: "OK", reply: wrapUp(null), doctorQuestionDropped: ["SOMETHING_ELSE"] }));
      expect(await instance.nextTurn(wrapRequest)).toMatchObject({ source: "REVIEWED_BANK", reason: "RESPONSE_INVALID" });
    });
  });

  it("never logs", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const { instance } = client(() => json({ kind: "OK", reply: { ...QUESTION, question: "Do you have insomnia?" } }));
    await instance.nextTurn(turn(1));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("fake feelings-chat port", () => {
  it("runs scripted candidates through the same validator, falls back with a reason, and records the requests", async () => {
    const port = createFakeFeelingsChatPort([{ candidate: QUESTION }, { candidate: { ...QUESTION, question: "Is your sugar high because of stress?" } }, { unavailable: "OFFLINE" }]);
    expect(await port.nextTurn(turn(1))).toEqual({ source: "AI_VALIDATED", reply: QUESTION });
    expect(await port.nextTurn(turn(1))).toMatchObject({ source: "REVIEWED_BANK", reason: "REJECTED_ON_DEVICE" });
    expect(await port.nextTurn(turn(1))).toMatchObject({ source: "REVIEWED_BANK", reason: "OFFLINE" });
    expect(await port.nextTurn(turn(3))).toMatchObject({ source: "REVIEWED_BANK", reason: "UPSTREAM_ERROR", reply: { kind: "WRAP_UP", summary: FIRST } });
    expect(port.requests()).toHaveLength(4);
    expect(port.interventions()).toMatchObject({ requests: 4, aiAccepted: 1, rejectedOnDevice: 1, unavailable: 2, rulesSteppedIn: 1 });
  });
});
