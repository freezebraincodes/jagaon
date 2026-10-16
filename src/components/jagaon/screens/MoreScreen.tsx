"use client";

import { type AppMessages } from "@/i18n/types";
import type { ScreenId } from "../screen-manifest";
import {
  BookIcon,
  CalendarCheckIcon,
  ChevronRightIcon,
  ClipboardIcon,
  ClockIcon,
  LifebuoyIcon,
  LockIcon,
  PencilIcon,
  PillIcon,
  ShareIcon,
} from "../primitives/Icons";
import { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen";

type MoreScreenProps = Omit<SettingsScreenProps, "messages" | "goBack"> & {
  messages: AppMessages;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
};

/** Owner decision 2026-10-12: "Export to other apps" is hidden until it exists (it was shown as unavailable). */
const SHOW_EXPORT_TO_OTHER_APPS = false;

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
          {/* Owner decision 2026-10-12: My notes replaces the Reminders placeholder tile. */}
          <button type="button" className="more-tile" onClick={() => navigate("MY_NOTES")}>
            <PencilIcon size={30} className="icon more-tile-icon" />
            <span className="more-tile-label">{messages.myNotes.title}</span>
          </button>
        </div>

        {/* Owner decision 2026-10-16: the Medication schedule moved here from the Booklet tab. */}
        <button type="button" className="more-row" onClick={() => navigate("MEDICATION_SCHEDULE")}>
          <ClockIcon size={30} className="icon more-row-icon" />
          <span className="more-row-text">
            <span className="more-row-label">{messages.schedule.title}</span>
            <span className="more-row-body">{messages.booklet.scheduleRowBody}</span>
          </span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
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
        {SHOW_EXPORT_TO_OTHER_APPS ? (
          <div
            className="more-row more-row--future"
            role="group"
            aria-labelledby="more-export-title"
            aria-disabled="true"
            aria-describedby={laterId}
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
        ) : null}
      </section>

      <SettingsScreen messages={messages} {...settings} />
    </div>
  );
}
