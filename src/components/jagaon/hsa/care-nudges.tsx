"use client";

import { useEffect, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { CareOrganisationQueryPort } from "@/application/care-organisation/care-organisation-contracts";
import { computeCareNudges, type CareNudge, type CareNudgeSummary } from "@/application/preview/care-nudges";
import { BellIcon, DropIcon, EyeIcon, WalkIcon } from "../primitives/Icons";
import { PreviewTag, useHsaBoundedMode } from "./hsa-bounded-mode";

/**
 * PREVIEW (HSA-bounded mode OFF, owner decision 2026-10-14): care checks due by standard intervals, with a visual bell only (no sound,
 * no notification). While the mode is ON nothing here loads or renders and the More badge stays hidden.
 */

/**
 * Loads the patient's reported completions and works out the preview summary while HSA-bounded mode is off, keeping the More tab badge
 * in step (0 when nothing is due or the data cannot be read). Returns null while the mode is on or before the first load.
 * `refreshKey` reloads it, e.g. when the visible screen changes after a check was recorded.
 */
export function useCareNudgeSummary(
  query: Pick<CareOrganisationQueryPort, "loadPreventiveCare"> | undefined,
  refreshKey?: unknown,
  now: () => Date = () => new Date(),
): CareNudgeSummary | null {
  const { bounded, setMoreBadgeCount } = useHsaBoundedMode();
  const [summary, setSummary] = useState<CareNudgeSummary | null>(null);
  useEffect(() => {
    if (bounded || !query) {
      setMoreBadgeCount(0);
      return;
    }
    let active = true;
    query
      .loadPreventiveCare()
      .then((view) => (view.status === "READY" ? computeCareNudges(view.reportedCompletions ?? [], now()) : null))
      .catch(() => null)
      .then((next) => {
        if (!active) return;
        setSummary(next);
        setMoreBadgeCount(next?.dueCount ?? 0);
      });
    return () => {
      active = false;
    };
    // `now` is a clock, not an input: a new function each render must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounded, query, refreshKey, setMoreBadgeCount]);
  return bounded || !query ? null : summary;
}

function nudgeIcon(key: CareNudge["key"]) {
  if (key === "EYE_SCREENING") return <EyeIcon size={24} />;
  if (key === "BLOOD_TEST") return <DropIcon size={24} />;
  return <WalkIcon size={24} />;
}

function monthYear(locale: SupportedLocale, localDate: string): string {
  const [year, month] = localDate.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function whenText(messages: AppMessages, nudge: CareNudge): string | null {
  const copy = messages.hsaCareNudges;
  if (!nudge.dueIn) return null;
  const amount =
    nudge.dueIn.unit === "MONTHS" ? copy.months(nudge.dueIn.count) : nudge.dueIn.unit === "WEEKS" ? copy.weeks(nudge.dueIn.count) : copy.days(nudge.dueIn.count);
  return nudge.status === "DUE_SOON" ? copy.dueSoon(amount) : copy.dueIn(amount);
}

/** Card header while the mode is off: bell with the due count, heading and the PREVIEW tag. Keeps the heading id the card is labelled by. */
export function CareNudgeHeader({ messages, summary, headingId }: { messages: AppMessages; summary: CareNudgeSummary; headingId: string }) {
  const copy = messages.hsaCareNudges;
  const due = summary.dueCount;
  return (
    <div className="care-nudge-header">
      <span className={`care-nudge-bell${due > 0 ? " care-nudge-bell--due" : ""}`} role="img" aria-label={copy.bellLabel(due)}>
        <BellIcon size={22} />
        {due > 0 ? (
          <span className="care-nudge-bell-count" aria-hidden="true">
            {due}
          </span>
        ) : null}
      </span>
      <h2 id={headingId} className="eyebrow care-nudge-heading">
        {copy.heading(due)}
      </h2>
      <PreviewTag messages={messages} />
    </div>
  );
}

/** The checks by standard interval, due first. "Set a date" opens My health checks, where the patient enters the date. */
export function CareNudgeList({
  messages,
  locale,
  summary,
  onSetDate,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  summary: CareNudgeSummary;
  onSetDate: () => void;
}) {
  const copy = messages.hsaCareNudges;
  return (
    <ul className="care-nudges" aria-label={copy.listLabel}>
      {summary.nudges.map((nudge) => {
        const label = copy.itemLabel[nudge.key];
        const when = whenText(messages, nudge);
        return (
          <li key={nudge.key} className={`care-nudge care-nudge--${nudge.status.toLowerCase().replace("_", "-")}`}>
            <span className="care-nudge-icon" aria-hidden="true">
              {nudgeIcon(nudge.key)}
            </span>
            <div className="care-nudge-body">
              <p className="care-nudge-title">
                <span className="care-nudge-label">{label}</span>
                {nudge.status === "DUE" ? <span className="care-nudge-chip">{copy.dueChip}</span> : <span className="care-nudge-when">{when}</span>}
              </p>
              <p className="care-nudge-detail">
                {nudge.lastDoneOn !== null && nudge.monthsSinceLastDone !== null
                  ? copy.lastRecorded(monthYear(locale, nudge.lastDoneOn), copy.monthsAgo(nudge.monthsSinceLastDone))
                  : copy.noRecord}
              </p>
              <p className="provenance-line care-nudge-source">{`${copy.cadence[nudge.cadence]} · ${copy.source}`}</p>
              {nudge.status !== "NOT_DUE" ? (
                <button type="button" className="btn btn-outline care-nudge-action" onClick={onSetDate}>
                  {copy.setDate}
                  <span className="sr-only">{` · ${label}`}</span>
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
