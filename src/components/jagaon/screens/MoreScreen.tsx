"use client";

import type { ReactNode } from "react";
import { type AppMessages } from "@/i18n/types";
import type { ScreenId } from "../screen-manifest";
import {
  BellIcon,
  BookIcon,
  CalendarCheckIcon,
  ChevronRightIcon,
  ClipboardIcon,
  LifebuoyIcon,
  LockIcon,
  PillIcon,
  ShareIcon,
} from "../primitives/Icons";
import { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen";

type MoreScreenProps = Omit<SettingsScreenProps, "messages" | "goBack"> & {
  messages: AppMessages;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
};

/** A later-packet destination: visible as in frame 12, but not operable. */
function FutureTile({ icon, label, laterId }: { icon: ReactNode; label: string; laterId: string }) {
  return (
    <button
      type="button"
      className="more-tile more-tile--future"
      aria-disabled="true"
      aria-describedby={laterId}
    >
      {icon}
      <span className="more-tile-label">{label}</span>
    </button>
  );
}

export function MoreScreen({ messages, navigate, ...settings }: MoreScreenProps) {
  const msg = messages.more;
  const laterId = "more-later-packet";

  return (
    <div className="screen-page more-screen">
      <h1 className="more-title">{msg.title}</h1>
      <p className="sr-only" id={laterId}>
        {messages.today.futureFeature}
      </p>

      <section className="more-section" aria-labelledby="more-information-heading">
        <h2 id="more-information-heading" className="sr-only">
          {msg.informationHeading}
        </h2>
        <div className="more-tiles">
          <button
            type="button"
            className="more-tile"
            onClick={() => navigate("MY_MEDICINES")}
          >
            <PillIcon size={30} className="icon more-tile-icon" />
            <span className="more-tile-label">{messages.medication.screenTitle}</span>
          </button>
          <button type="button" className="more-tile" onClick={() => navigate("PREVENTIVE_CARE")}>
            <CalendarCheckIcon size={30} className="icon more-tile-icon" />
            <span className="more-tile-label">{msg.healthChecks}</span>
          </button>
          <button type="button" className="more-tile" onClick={() => navigate("CARE_PREPARATION")}>
            <ClipboardIcon size={30} className="icon more-tile-icon" />
            <span className="more-tile-label">{msg.prepareVisit}</span>
          </button>
          <FutureTile
            icon={<BellIcon size={30} className="icon more-tile-icon" />}
            label={msg.reminders}
            laterId={laterId}
          />
        </div>

        <button type="button" className="more-row" onClick={() => navigate("NEARBY_FOOD")}>
          <BookIcon size={30} className="icon more-row-icon" />
          <span className="more-row-text">
            <span className="more-row-label">{msg.foodInformation}</span>
            <span className="more-row-body">{msg.foodInformationBody}</span>
          </span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
        <button type="button" className="more-row" onClick={() => navigate("HELP_INFORMATION")}>
          <LifebuoyIcon size={30} className="icon more-row-icon" />
          <span className="more-row-text">
            <span className="more-row-label">{msg.helpInfo}</span>
            <span className="more-row-body">{msg.helpBody}</span>
          </span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
        {/* Packet 10: a distinct destination above the untouched "Export to other apps" row. */}
        <button type="button" className="more-row more-row--data" onClick={() => navigate("DATA_BACKUP")}>
          <LockIcon size={30} className="icon more-row-icon" />
          <span className="more-row-text">
            <span className="more-row-label">{messages.packet10.more.data}</span>
            <span className="more-row-body">{messages.packet10.more.dataSub}</span>
          </span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
        <div
          className="more-row more-row--future"
          role="group"
          aria-labelledby="more-export-title"
          aria-disabled="true"
        >
          <ShareIcon size={30} className="icon more-row-icon" />
          <span className="more-row-text">
            <span className="more-row-label" id="more-export-title">
              {msg.exportApps}
            </span>
            <span className="more-row-body">{msg.exportBody}</span>
          </span>
          <span className="status-pill">{messages.shared.unavailable}</span>
        </div>
      </section>

      <SettingsScreen messages={messages} {...settings} />
    </div>
  );
}
