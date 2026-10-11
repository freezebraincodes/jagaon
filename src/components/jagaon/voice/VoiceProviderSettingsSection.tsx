"use client";

import { useEffect, useId, useState } from "react";
import { resolveVoiceProvider, voiceProviderStatuses, type VoiceProviderId, type VoiceProviderProbeAnswer } from "@/application/voice/voice-provider-selection";
import type { SupportedLocale } from "@/i18n/types";
import { VOICE_PROVIDER_SETTINGS_COPY } from "./voice-provider-settings-copy";

/**
 * Web Speech (owner-approved scope 2026-10-11; owner clarification: minimal): the System settings section, rendered only when the
 * build-time developer-settings flag is on. It holds ONE control: the voice provider for the next session in this browser.
 * - Only providers that are deployment-enabled AND usable here can be chosen; every other one is shown disabled with a one-line reason.
 * - The checked provider is the effective one (the stored choice when it is usable, else the deployment's first usable provider).
 * - Disabled while a session is starting, listening or stopping (`busy`), and while the probe answer is pending.
 * - Choosing only remembers the choice (`onSelect`): it never starts a microphone, a session or a provider, and never falls back.
 * - It shows and holds nothing else: no credential, passcode, identifier, transcript, spending, activation or diagnostic.
 */
export type VoiceProviderSettingsSectionProps = Readonly<{
  locale: SupportedLocale;
  /** The deployment-enabled providers (the credential-free probe), or its answer telling a failed check apart (round 6). */
  probe: () => Promise<readonly VoiceProviderId[] | VoiceProviderProbeAnswer>;
  webSpeechSupported: () => boolean;
  /** The stored choice for this browser (null: none). */
  stored: VoiceProviderId | null;
  onSelect: (provider: VoiceProviderId) => void;
  /** True while a voice session is active. */
  busy: boolean;
}>;

export function VoiceProviderSettingsSection({ locale, probe, webSpeechSupported, stored, onSelect, busy }: VoiceProviderSettingsSectionProps) {
  const copy = VOICE_PROVIDER_SETTINGS_COPY[locale] ?? VOICE_PROVIDER_SETTINGS_COPY["en-SG"];
  const id = useId();
  const [enabled, setEnabled] = useState<readonly VoiceProviderId[] | null>(null);
  // Round 6: the check failed (network, rate limit, invalid answer): providers not known to be disabled say "could not check".
  const [unchecked, setUnchecked] = useState<readonly VoiceProviderId[] | null>(null);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    let current = true;
    const detect = () => {
      try {
        return webSpeechSupported() === true;
      } catch {
        return false;
      }
    };
    void probe()
      .then(
        (answer): VoiceProviderProbeAnswer =>
          Array.isArray(answer) ? { kind: "ANSWERED", providers: answer } : answer && typeof answer === "object" && "kind" in answer && (answer.kind === "ANSWERED" || answer.kind === "FAILED") ? answer : { kind: "FAILED", notEnabled: [] },
        (): VoiceProviderProbeAnswer => ({ kind: "FAILED", notEnabled: [] }),
      )
      .then((answer) => {
        if (!current) return;
        setSupported(detect());
        setUnchecked(answer.kind === "FAILED" ? (["TRTC", "WEB_SPEECH"] as const).filter((provider) => !answer.notEnabled.includes(provider)) : null);
        setEnabled(answer.kind === "ANSWERED" ? answer.providers : []);
      });
    return () => {
      current = false;
    };
  }, [probe, webSpeechSupported]);

  const environment = { enabled: enabled ?? [], webSpeechSupported: supported, language: locale === "zh-SG" ? ("zh" as const) : ("en" as const) };
  const statuses = voiceProviderStatuses(environment);
  const effective = enabled === null ? null : resolveVoiceProvider(environment, { devSettingsEnabled: true, stored });
  const checked = effective?.kind === "AVAILABLE" ? effective.provider : null;
  const headingId = `${id}-system-heading`;

  return (
    <>
      <h2 className="eyebrow" id={headingId}>
        {copy.heading}
      </h2>
      <fieldset className="setting-card voice-provider-setting" aria-labelledby={headingId} disabled={busy || enabled === null}>
        <legend className="setting-title">{copy.providerLabel}</legend>
        {/* Round 4 (truth by state): no provider row or reason before the deployment's answer arrives, so "Not enabled by this
            deployment." is never shown while it is still unknown. */}
        {(enabled === null ? [] : statuses).map(({ provider, status }) => {
          const optionId = `${id}-${provider}`;
          const reasonId = `${optionId}-reason`;
          const available = status === "AVAILABLE";
          return (
            <div className="setting-row" key={provider}>
              <input
                id={optionId}
                type="radio"
                name={`${id}-voice-provider`}
                value={provider}
                checked={checked === provider}
                disabled={!available}
                aria-describedby={available ? undefined : reasonId}
                onChange={() => {
                  if (available && !busy) onSelect(provider);
                }}
              />
              <span className="setting-text">
                <label className="setting-title" htmlFor={optionId}>
                  {copy.providers[provider]}
                </label>
                {available ? null : (
                  <span className="setting-body" id={reasonId}>
                    {status === "NOT_ENABLED" && unchecked?.includes(provider) ? copy.reasons.NOT_CHECKED : copy.reasons[status]}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </fieldset>
    </>
  );
}
