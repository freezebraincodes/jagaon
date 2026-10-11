// @vitest-environment jsdom
// jsdom is deliberate: a React component test like the existing screen tests. No network: the probe is an injected function.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceProviderId } from "@/application/voice/voice-provider-selection";
import { VoiceProviderSettingsSection } from "./VoiceProviderSettingsSection";
import { VOICE_PROVIDER_SETTINGS_COPY } from "./voice-provider-settings-copy";
import { createVoiceProviderAnswerCheck, createVoiceProvidersCheck } from "./voice-provider-wiring";

const en = VOICE_PROVIDER_SETTINGS_COPY["en-SG"];
afterEach(() => cleanup());

/** Round 4 (owner requirement): each panel reason appears only where its wording is true. */
describe("System settings voice provider section: reasons are true in every state", () => {
  it("shows no row or reason while the deployment's answer is pending; then each reason only where it holds", async () => {
    let answer!: (providers: readonly VoiceProviderId[]) => void;
    const probe = vi.fn(() => new Promise<readonly VoiceProviderId[]>((resolve) => (answer = resolve)));
    const onSelect = vi.fn();
    render(<VoiceProviderSettingsSection locale="en-SG" probe={probe} webSpeechSupported={() => false} stored={null} onSelect={onSelect} busy={false} />);
    expect(screen.getByText(en.heading)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    for (const reason of Object.values(en.reasons)) expect(screen.queryByText(reason)).toBeNull();
    await act(async () => answer(["WEB_SPEECH"]));
    // Web Speech is enabled but this browser lacks it; TRTC is not enabled by this deployment.
    expect((screen.getByRole("radio", { name: en.providers.WEB_SPEECH }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(en.reasons.NOT_SUPPORTED)).toBeInTheDocument();
    expect(screen.getByText(en.reasons.NOT_ENABLED)).toBeInTheDocument();
    expect(screen.getAllByText(en.reasons.NOT_ENABLED)).toHaveLength(1);
    expect(screen.queryByText(en.reasons.NOT_IN_LANGUAGE)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: en.providers.TRTC }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("an available provider shows no reason; the ZH UI shows Web Speech as not offered in this language (ZH labels: draft)", async () => {
    render(<VoiceProviderSettingsSection locale="en-SG" probe={async () => ["WEB_SPEECH", "TRTC"]} webSpeechSupported={() => true} stored={null} onSelect={() => undefined} busy={false} />);
    await screen.findByRole("radio", { name: en.providers.WEB_SPEECH });
    for (const reason of Object.values(en.reasons)) expect(screen.queryByText(reason)).toBeNull();
    cleanup();
    const zh = VOICE_PROVIDER_SETTINGS_COPY["zh-SG"];
    render(<VoiceProviderSettingsSection locale="zh-SG" probe={async () => ["WEB_SPEECH", "TRTC"]} webSpeechSupported={() => true} stored="WEB_SPEECH" onSelect={() => undefined} busy={false} />);
    expect(await screen.findByText(zh.reasons.NOT_IN_LANGUAGE)).toBeInTheDocument();
    expect((screen.getByRole("radio", { name: zh.providers.TRTC }) as HTMLInputElement).checked).toBe(true);
  });

  it("Tencent build-time exclusion: even if the server (mistakenly) lists TRTC, an excluded build shows TRTC with the approved 'Not enabled by this deployment.' reason", async () => {
    const onSelect = vi.fn();
    render(<VoiceProviderSettingsSection locale="en-SG" probe={createVoiceProvidersCheck(async () => ["TRTC", "WEB_SPEECH"], true)} webSpeechSupported={() => true} stored="TRTC" onSelect={onSelect} busy={false} />);
    const trtc = (await screen.findByRole("radio", { name: en.providers.TRTC })) as HTMLInputElement;
    expect(trtc.disabled).toBe(true);
    expect(trtc.checked).toBe(false);
    expect(screen.getByText(en.reasons.NOT_ENABLED)).toBeInTheDocument();
    expect((screen.getByRole("radio", { name: en.providers.WEB_SPEECH }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(trtc);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("round 6: a failed or rate-limited check says 'Could not check this deployment.' instead of the untrue 'Not enabled…'; an excluded build still knows TRTC is not enabled", async () => {
    render(<VoiceProviderSettingsSection locale="en-SG" probe={createVoiceProviderAnswerCheck(async () => ({ kind: "FAILED" }), false)} webSpeechSupported={() => true} stored={null} onSelect={() => undefined} busy={false} />);
    await screen.findByRole("radio", { name: en.providers.TRTC });
    expect(screen.getAllByText(en.reasons.NOT_CHECKED)).toHaveLength(2);
    expect(screen.queryByText(en.reasons.NOT_ENABLED)).toBeNull();
    for (const provider of ["TRTC", "WEB_SPEECH"] as const) expect((screen.getByRole("radio", { name: en.providers[provider] }) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    render(<VoiceProviderSettingsSection locale="en-SG" probe={createVoiceProviderAnswerCheck(async () => Promise.reject(new Error("offline")), true)} webSpeechSupported={() => true} stored={null} onSelect={() => undefined} busy={false} />);
    await screen.findByRole("radio", { name: en.providers.TRTC });
    expect(screen.getAllByText(en.reasons.NOT_ENABLED)).toHaveLength(1);
    expect(screen.getAllByText(en.reasons.NOT_CHECKED)).toHaveLength(1);
    cleanup();
    // An answered "voice off" (no provider enabled) is still "Not enabled by this deployment.".
    render(<VoiceProviderSettingsSection locale="en-SG" probe={createVoiceProviderAnswerCheck(async () => ({ kind: "ANSWERED", providers: [] }), false)} webSpeechSupported={() => true} stored={null} onSelect={() => undefined} busy={false} />);
    await screen.findByRole("radio", { name: en.providers.TRTC });
    expect(screen.getAllByText(en.reasons.NOT_ENABLED)).toHaveLength(2);
    expect(screen.queryByText(en.reasons.NOT_CHECKED)).toBeNull();
  });
});
