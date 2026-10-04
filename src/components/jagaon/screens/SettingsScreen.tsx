"use client";

import { useRef, useState } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import { Banner, ToggleGroup } from "../primitives/Card";
import type { DeleteAllPort } from "../data/data-ports";
import { DeleteAllDialog } from "../data/DeleteAllDialog";
import {
  ContrastIcon,
  DeviceIcon,
  FlaskIcon,
  LanguageIcon,
  LockIcon,
  RulerIcon,
  TrashIcon,
} from "../primitives/Icons";

export type SettingsScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  persistLocale: (locale: SupportedLocale) => Promise<void>;
  /** Packet 10A: truthful whole-dataset deletion replaces the synthetic reseed. */
  deleteAll: DeleteAllPort;
  onDatasetDeleted: () => void;
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
  deleteAll,
  onDatasetDeleted,
}: SettingsScreenProps) {
  const msg = messages.settings;
  const more = messages.more;
  const [savedVisible, setSavedVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [storageError, setStorageError] = useState(false);

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
        <button ref={deleteButton} type="button" className="btn btn-danger-outline btn-wide" onClick={() => setDeleteVisible(true)}>
          <TrashIcon size={20} />
          {messages.packet10.hub.deleteAll}
        </button>
        <p className="field-hint">{messages.packet10.hub.deleteAllHelp}</p>
        {deleteVisible ? (
          <DeleteAllDialog
            messages={messages}
            port={deleteAll}
            onClose={() => setDeleteVisible(false)}
            onDeleted={onDatasetDeleted}
            returnFocusRef={deleteButton}
          />
        ) : null}
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
