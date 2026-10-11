import type { VoiceProviderId, VoiceProviderStatus } from "@/application/voice/voice-provider-selection";
import type { SupportedLocale } from "@/i18n/types";

/**
 * Web Speech (owner-approved scope 2026-10-11): the System settings section's copy. EN: owner-approved wording, 2026-10-11 (verbatim).
 * The ZH rows exist because the section renders in either UI language; they are a draft, pending owner review (Chinese acceptance
 * deferred).
 */
export type VoiceProviderSettingsCopy = Readonly<{
  heading: string;
  providerLabel: string;
  providers: Readonly<Record<VoiceProviderId, string>>;
  /** The one-line reason beside a provider that cannot be chosen. */
  /** NOT_CHECKED (round 6): the deployment could not be checked (the probe failed or was rate-limited). */
  reasons: Readonly<Record<Exclude<VoiceProviderStatus, "AVAILABLE"> | "NOT_CHECKED", string>>;
}>;

export const VOICE_PROVIDER_SETTINGS_COPY: Readonly<Record<SupportedLocale, VoiceProviderSettingsCopy>> = Object.freeze({
  // Owner-approved wording, 2026-10-11.
  "en-SG": Object.freeze({
    heading: "System settings",
    providerLabel: "Voice provider",
    providers: Object.freeze({ TRTC: "Tencent Cloud speech (TRTC)", WEB_SPEECH: "Browser speech recognition (Web Speech)" }),
    // NOT_CHECKED: owner-approved wording, round 6 (2026-10-11).
    reasons: Object.freeze({ NOT_ENABLED: "Not enabled by this deployment.", NOT_SUPPORTED: "Not supported by this browser.", NOT_IN_LANGUAGE: "Not offered in this language.", NOT_CHECKED: "Could not check this deployment." }),
  }),
  // Draft, pending owner review (ZH).
  "zh-SG": Object.freeze({
    heading: "系统设置",
    providerLabel: "语音服务",
    providers: Object.freeze({ TRTC: "腾讯云语音（TRTC）", WEB_SPEECH: "浏览器语音识别（Web Speech）" }),
    // NOT_CHECKED: draft, pending owner review (round 6).
    reasons: Object.freeze({ NOT_ENABLED: "此部署未启用。", NOT_SUPPORTED: "此浏览器不支持。", NOT_IN_LANGUAGE: "此语言不提供。", NOT_CHECKED: "无法检查此部署。" }),
  }),
});
