"use client";

import { useEffect, useState } from "react";
import type { AppMessages } from "@/i18n/types";
import type { HabitTrend, PreviewInsightsQueryPort } from "@/application/preview/preview-insights-contracts";
import { PreviewTag, useHsaBoundedMode } from "../hsa/hsa-bounded-mode";
import { InfoIcon } from "../primitives/Icons";

const UNIT = "mmol/L";

type Props = {
  messages: AppMessages;
  previewInsights: PreviewInsightsQueryPort | null;
};

/**
 * HSA-bounded mode PREVIEW (owner decision 2026-10-14): "What changed alongside" a new habit on History. While HSA-bounded mode is ON
 * (the default) this renders nothing and reads nothing. While it is OFF it reads the preview habit trend once; when nothing qualifies it
 * shows one short "not enough records yet" line (tagged Preview), so the preview's absence is explained rather than silent. The
 * timing-not-proof note is always visible with the numbers; the numbers are text, the bars only repeat them.
 */
export function HabitTrendPreviewCard({ messages, previewInsights }: Props) {
  const { bounded } = useHsaBoundedMode();
  const [trend, setTrend] = useState<{ value: HabitTrend | null } | null>(null);

  useEffect(() => {
    if (bounded || !previewInsights) return;
    let live = true;
    previewInsights.habitTrend().then(
      (value) => {
        if (live) setTrend({ value });
      },
      () => {
        if (live) setTrend({ value: null });
      },
    );
    return () => {
      live = false;
    };
  }, [bounded, previewInsights]);

  if (bounded || !previewInsights || trend === null) return null;
  const msg = messages.hsaTrend;
  const value = trend.value;
  if (value === null) {
    return (
      <p className="habit-trend-empty">
        <PreviewTag messages={messages} /> {msg.notEnough}
      </p>
    );
  }

  const before = Number(value.beforeMedian);
  const after = Number(value.afterMedian);
  const widest = Math.max(before, after) || 1;
  const rows = [
    { key: "before", label: msg.before, text: value.beforeMedian, width: (before / widest) * 100 },
    { key: "after", label: msg.after, text: value.afterMedian, width: (after / widest) * 100 },
  ];

  return (
    <section className="today-card habit-trend" aria-labelledby="habit-trend-heading">
      <div className="habit-trend-head">
        <PreviewTag messages={messages} />
        <h2 id="habit-trend-heading" className="card-title">
          {msg.title}
        </h2>
      </div>
      <p className="habit-trend-headline">{msg.headline(msg.slotSubjects[value.slot], value.percentChange, value.direction)}</p>
      <p className="habit-trend-since">{msg.since(value.daysSince, value.habitLabel, value.habitCount)}</p>
      <dl className="habit-trend-bars">
        {rows.map((row) => (
          <div key={row.key} className={`habit-trend-row habit-trend-row--${row.key}`}>
            <dt>{row.label}</dt>
            <dd>
              <span className="habit-trend-track" aria-hidden="true">
                <span className="habit-trend-bar" style={{ width: `${row.width}%` }} />
              </span>
              <span className="habit-trend-value">{row.text}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="habit-trend-caption">
        {msg.medianCaption(UNIT)} · {msg.readingCounts(value.beforeCount, value.afterCount)}
      </p>
      <p className="history-note habit-trend-note">
        <InfoIcon size={20} />
        <span>{msg.note(value.habitLabel)}</span>
      </p>
    </section>
  );
}
