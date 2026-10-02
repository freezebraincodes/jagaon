"use client";

import { useState } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import { Button } from "../primitives/Button";
import { Banner, ToggleGroup } from "../primitives/Card";
import {
  ContrastIcon,
  DeviceIcon,
  FlaskIcon,
  LanguageIcon,
  LockIcon,
  ResetIcon,
  RulerIcon,
} from "../primitives/Icons";

export type SettingsScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  persistLocale: (locale: SupportedLocale) => Promise<void>;
  resetDemo: () => Promise<void>;
  goBack?: () => void;
};

/**
 * Settings section of frame 12. It renders inside More rather than as a
 * separate route so the closed Packet 6 screen manifest stays exact.
 */
export function SettingsScreen({
  messages,
  locale,
  setLocale,
  persistLocale,
  resetDemo,
}: SettingsScreenProps) {
  const msg = messages.settings;
  const more = messages.more;
  const [savedVisible, setSavedVisible] = useState(false);
  const [resetVisible, setResetVisible] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleLocaleChange(value: string) {
    const nextLocale = value as SupportedLocale;
    setLocale(nextLocale);
    setSavedVisible(false);
    setStorageError(false);
    try {
      await persistLocale(nextLocale);
      setSavedVisible(true);
    } catch {
      setStorageError(true);
    }
  }

  async function handleReset() {
    setBusy(true);
    setStorageError(false);
    try {
      await resetDemo();
      setResetDone(true);
      setResetVisible(false);
    } catch {
      setStorageError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="eyebrow">
        {messages.more.settingsHeading}
      </h2>

      {savedVisible ? <Banner variant="success">{msg.languageSaved}</Banner> : null}
      {storageError ? (
        <Banner variant="error">{messages.shared.storageUnavailable}</Banner>
      ) : null}

      {/* Text size is a later setting; shown as in frame 12 but not operable. */}
      <div className="setting-card setting-card--future" role="group" aria-labelledby="text-size-title" aria-disabled="true">
        <p className="eyebrow" id="text-size-title">
          {more.textSize}
        </p>
        <div className="text-size-row">
          <button type="button" className="stepper-button" aria-label={more.smallerText} aria-disabled="true">
            <span aria-hidden="true">A−</span>
          </button>
          <p className="text-size-sample">{more.textSizeSample}</p>
          <button type="button" className="stepper-button" aria-label={more.largerText} aria-disabled="true">
            <span aria-hidden="true">A+</span>
          </button>
        </div>
        <p className="provenance-line">{messages.today.futureFeature}</p>
      </div>

      <div className="setting-row">
        <LanguageIcon size={26} className="icon setting-icon" />
        <span className="setting-title" id="language-setting-label">
          {msg.language}
        </span>
        <ToggleGroup
          label={msg.language}
          options={[
            { label: msg.english, value: "en-SG" },
            { label: msg.chinese, value: "zh-SG" },
          ]}
          value={locale}
          onChange={handleLocaleChange}
        />
      </div>

      <div className="setting-row setting-row--future" role="group" aria-labelledby="contrast-title" aria-disabled="true">
        <ContrastIcon size={26} className="icon setting-icon" />
        <span className="setting-text">
          <span className="setting-title" id="contrast-title">
            {more.extraContrast}
          </span>
          <span className="setting-body">{more.extraContrastBody}</span>
          <span className="setting-body">{messages.today.futureFeature}</span>
        </span>
        <span className="switch" role="switch" aria-checked="false" aria-disabled="true" aria-labelledby="contrast-title">
          <span className="switch-label">{more.off}</span>
          <span className="switch-track" aria-hidden="true" />
        </span>
      </div>

      <div className="setting-row" role="group" aria-labelledby="units-title">
        <RulerIcon size={26} className="icon setting-icon" />
        <span className="setting-text">
          <span className="setting-title" id="units-title">
            {more.units}
          </span>
          <span className="setting-body">{more.unitsBody}</span>
        </span>
        <span className="setting-value">{messages.glucose.unit}</span>
      </div>

      <h2 className="eyebrow" id="demo-data-heading">
        {msg.dataHeading}
      </h2>
      <div className="setting-card" role="group" aria-labelledby="demo-data-heading">
        {resetVisible ? (
          <div className="reset-confirm" role="alertdialog" aria-labelledby="reset-title" aria-describedby="reset-body">
            <p className="reset-title" id="reset-title">
              {msg.resetTitle}
            </p>
            <p className="reset-body" id="reset-body">
              {msg.resetBody}
            </p>
            <div className="button-row">
              <Button variant="primary" onClick={handleReset} busy={busy}>
                {msg.resetConfirm}
              </Button>
              <Button variant="ghost" onClick={() => setResetVisible(false)}>
                {messages.shared.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setResetDone(false);
              setResetVisible(true);
            }}
          >
            <ResetIcon size={20} />
            {msg.resetAction}
          </Button>
        )}
        {resetDone ? <Banner variant="success">{msg.resetDone}</Banner> : null}
      </div>

      <h2 className="eyebrow" id="about-demo-heading">
        {more.aboutDemo}
      </h2>
      <ul className="about-list setting-card" aria-labelledby="about-demo-heading">
        <li>
          <FlaskIcon size={24} className="icon setting-icon" />
          <span>
            <span className="setting-title">{more.syntheticTitle}</span>
            <span className="setting-body">{more.syntheticBody}</span>
          </span>
        </li>
        <li>
          <DeviceIcon size={24} className="icon setting-icon" />
          <span>
            <span className="setting-title">{more.storageTitle}</span>
            <span className="setting-body">{more.storageBody}</span>
          </span>
        </li>
        <li>
          <LockIcon size={24} className="icon setting-icon" />
          <span>
            <span className="setting-title">{more.boundaryTitle}</span>
            <span className="setting-body">{more.boundaryBody}</span>
          </span>
        </li>
      </ul>
    </section>
  );
}
