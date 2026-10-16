"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { HISTORY_DISPLAY_POSITIONS, type HistoryChartPosition, type HistoryPeriod } from "@/application/history/recorded-history-contracts";
import { formatSingaporeTime } from "../journal/singapore-time";
import { formatChartDay, formatShortDate } from "./history-format";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  period: HistoryPeriod;
  chart: readonly HistoryChartPosition[];
  headingId: string;
};

const UNIT = "mmol/L";

/**
 * Neutral recorded-readings chart (design Section 8.2). Owner decision 2026-10-16: three times of day (morning, afternoon, evening),
 * each with its own calm colour and a legend; the colours name the time of day only (no status, target or risk meaning). A
 * not-recorded position is an empty dashed outline, never a zero bar. There is no target band, threshold line, risk zone, forecast or
 * annotation. The visual chart is hidden from assistive technology and the
 * table below carries every position, value and missing position.
 * CR-11 (AC-20z): a recorded 0.0 keeps a thin solid bar (drawn, never mistaken
 * for a not-recorded outline) and its stored text in the table.
 * Owner decision 2026-10-12: every reading is drawn. A position with several
 * readings shows one bar per reading, side by side in time order, within the
 * position's own width; the table lists each reading with its time.
 */
export function HistoryReadingsChart({ messages, locale, period, chart, headingId }: Props) {
  const msg = messages.history;
  const values = chart.flatMap((position) => (position.state === "RECORDED" ? position.readings.map((reading) => Number(reading.valueMmolL)) : []));
  const axisMax = Math.max(10, Math.ceil(Math.max(0, ...values) / 5) * 5);
  const ticks = Array.from({ length: axisMax / 5 + 1 }, (_, index) => index * 5);
  const days = [...new Set(chart.map((position) => position.date))];
  const recordedCount = chart.reduce((total, position) => total + (position.state === "RECORDED" ? position.readings.length : 0), 0);
  const descriptionId = `${headingId}-description`;

  return (
    <figure className="history-chart" aria-labelledby={headingId} aria-describedby={descriptionId}>
      <ul className="history-legend">
        {/* Owner decision 2026-10-16: one calm colour per time of day (never a status colour). */}
        {HISTORY_DISPLAY_POSITIONS.map((position) => (
          <li key={position}>
            <span className={`history-legend-swatch history-legend-swatch--${position.toLowerCase()}`} aria-hidden="true" />
            {msg.positionLegend[position]}
          </li>
        ))}
        <li>
          <span className="history-legend-swatch history-legend-swatch--missing" aria-hidden="true" />
          {msg.notRecordedLegend}
        </li>
      </ul>
      <div className="history-plot-frame" aria-hidden="true">
        <div className="history-axis">
          {ticks.map((tick) => (
            <span key={tick} className="history-axis-label" style={{ bottom: `${(tick / axisMax) * 100}%` }}>
              {tick}
            </span>
          ))}
        </div>
        <div className={`history-plot history-plot--${period === "THIRTY_DAYS" ? "month" : "week"}`}>
          {ticks.map((tick) => (
            <span key={tick} className="history-gridline" style={{ bottom: `${(tick / axisMax) * 100}%` }} />
          ))}
          {days.map((date) => (
            <div key={date} className="history-day">
              {chart
                .filter((position) => position.date === date)
                .map((position) => (
                  <span
                    key={position.position}
                    className="history-slot"
                    data-position={position.position}
                    // Several readings take a larger share of the day (and a wider limit), so each bar stays visible.
                    style={
                      position.state === "RECORDED" && position.readings.length > 1
                        ? { flexGrow: position.readings.length, maxWidth: `${Math.min(position.readings.length, 3)}rem` }
                        : undefined
                    }
                  >
                    {position.state === "RECORDED" ? (
                      position.readings.map((reading, index) => (
                        <span
                          key={index}
                          className={`history-bar history-bar--recorded history-bar--${position.position.toLowerCase()}${Number(reading.valueMmolL) === 0 ? " history-bar--zero" : ""}`}
                          data-value={reading.valueMmolL}
                          style={{ height: `${(Number(reading.valueMmolL) / axisMax) * 100}%` }}
                        />
                      ))
                    ) : (
                      <span className="history-bar history-bar--missing" />
                    )}
                  </span>
                ))}
            </div>
          ))}
        </div>
        <div className="history-day-labels">
          <span className="history-axis-spacer" />
          {days.map((date, index) => (
            <span key={date} className="history-day-label">
              {period !== "THIRTY_DAYS" || index % 7 === 0 ? formatChartDay(locale, date, period) : ""}
            </span>
          ))}
        </div>
      </div>
      <figcaption>
        <p className="history-chart-note">{msg.chartSlotsNote}</p>
        <p className="sr-only" id={descriptionId}>
          {msg.chartDescription(recordedCount, chart.length, UNIT)}
        </p>
      </figcaption>
      {/* Tables size to their content, so the hidden wrapper clips it, not the table. */}
      <div className="sr-only">
        <table>
          <caption>{msg.readingsTitle(UNIT)}</caption>
          <thead>
            <tr>
              <th scope="col">{msg.periodLabels[period]}</th>
              <th scope="col">{UNIT}</th>
            </tr>
          </thead>
          <tbody>
            {chart.flatMap((position) => {
              const label = `${formatShortDate(locale, position.date)}${locale === "zh-SG" ? "" : " "}${msg.positionLabels[position.position]}`;
              if (position.state !== "RECORDED") {
                return [
                  <tr key={`${position.date}-${position.position}`}>
                    <th scope="row">{label}</th>
                    <td>{msg.notRecordedLegend}</td>
                  </tr>,
                ];
              }
              return position.readings.map((reading, index) => (
                <tr key={`${position.date}-${position.position}-${index}`}>
                  <th scope="row">{`${label}${locale === "zh-SG" ? "，" : ", "}${formatSingaporeTime(locale, reading.at)}`}</th>
                  <td>{reading.valueMmolL}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
