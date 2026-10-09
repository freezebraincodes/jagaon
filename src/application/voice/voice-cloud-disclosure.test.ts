// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VOICE_DISCLOSURE_COPY_KEYS,
  VOICE_DISCLOSURE_COPY_VERSION,
  VOICE_DISCLOSURE_INITIAL_STATE,
  consumeVoiceDisclosureGrant,
  isVoiceDisclosureGrantUsable,
  voiceDisclosureReducer,
  type VoiceDisclosureAction,
  type VoiceDisclosureState,
} from "./voice-cloud-disclosure";

const run = (...actions: VoiceDisclosureAction[]): VoiceDisclosureState => actions.reduce(voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE);
const accepted = (language: "en" | "zh" = "en") => {
  const state = run({ type: "REQUEST_START", language }, { type: "ACCEPT" });
  if (state.kind !== "GRANTED") throw new Error("not accepted");
  return state;
};

describe("voice-cloud disclosure", () => {
  it("is labelled and uses copy keys only", () => {
    expect(VOICE_DISCLOSURE_COPY_VERSION).toBe("voice-disclosure.13s.1");
    expect(VOICE_DISCLOSURE_COPY_KEYS).toEqual({ title: "voice.disclosure.title", body: "voice.disclosure.body", accept: "voice.disclosure.accept", decline: "voice.disclosure.decline" });
  });

  it("shows, accepts and issues one one-shot grant for the start's language", () => {
    expect(run({ type: "REQUEST_START", language: "zh" })).toEqual({ kind: "SHOWN", language: "zh" });
    const state = accepted("zh");
    expect(state.grant.language).toBe("zh");
    expect(isVoiceDisclosureGrantUsable(state.grant)).toBe(true);
    expect(consumeVoiceDisclosureGrant(state.grant)).toBe(true);
    expect(consumeVoiceDisclosureGrant(state.grant)).toBe(false);
    expect(isVoiceDisclosureGrantUsable(state.grant)).toBe(false);
  });

  it("requires the disclosure again before every start", () => {
    const state = accepted();
    const used = voiceDisclosureReducer(state, { type: "GRANT_USED" });
    expect(used).toEqual({ kind: "IDLE" });
    // ACCEPT without a fresh REQUEST_START does nothing: no new grant.
    expect(voiceDisclosureReducer(used, { type: "ACCEPT" })).toEqual({ kind: "IDLE" });
    const again = voiceDisclosureReducer(voiceDisclosureReducer(used, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
    expect(again.kind).toBe("GRANTED");
    if (again.kind === "GRANTED") expect(again.grant).not.toBe(state.grant);
  });

  it("a decline gives no grant", () => {
    const declined = run({ type: "REQUEST_START", language: "en" }, { type: "DECLINE" });
    expect(declined).toEqual({ kind: "DECLINED" });
    expect(voiceDisclosureReducer(declined, { type: "ACCEPT" })).toEqual({ kind: "DECLINED" });
    const state = accepted();
    expect(voiceDisclosureReducer(state, { type: "DECLINE" })).toEqual({ kind: "DECLINED" });
    expect(consumeVoiceDisclosureGrant(state.grant)).toBe(false);
  });

  it("a locale change or a navigation makes the disclosure moot and revokes its grant", () => {
    for (const type of ["LOCALE_CHANGED", "NAVIGATED"] as const) {
      expect(run({ type: "REQUEST_START", language: "en" }, { type })).toEqual({ kind: "MOOT" });
      const state = accepted();
      expect(voiceDisclosureReducer(state, { type })).toEqual({ kind: "MOOT" });
      expect(consumeVoiceDisclosureGrant(state.grant), type).toBe(false);
    }
  });

  it("reset or a new request revokes an unused grant; forged grants are refused", () => {
    const first = accepted();
    voiceDisclosureReducer(first, { type: "RESET" });
    expect(consumeVoiceDisclosureGrant(first.grant)).toBe(false);
    const second = accepted();
    voiceDisclosureReducer(second, { type: "REQUEST_START", language: "zh" });
    expect(consumeVoiceDisclosureGrant(second.grant)).toBe(false);
    for (const forged of [undefined, null, {}, Object.freeze({ language: "en" }), "grant"]) expect(consumeVoiceDisclosureGrant(forged)).toBe(false);
  });

  it("is never persisted and is independent of the AI wording disclosure and keepWordingOnDevice", () => {
    const source = readFileSync(join(process.cwd(), "src/application/voice/voice-cloud-disclosure.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(["@/domain/voice/voice-contracts"]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|dexie|keepWordingOnDevice|remoteUse|application\/ai/);
  });
});
