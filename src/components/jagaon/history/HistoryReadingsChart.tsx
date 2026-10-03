"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { HistoryChartPosition, HistoryPeriod } from "@/application/history/recorded-history-contracts";
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
 * Neutral recorded-readings chart (design Section 8.2). Bars use one neutral
 * ink colour; a not-recorded position is an empty dashed outline, never a
 * zero bar. There is no target band, threshold line, risk zone, forecast or
 * annotation. The visual chart is hidden from assistive technology and the
 * table below carries every position, value and missing position.
 */
export function HistoryReadingsChart({ messages, locale, period, chart, headingId }: Props) {
  const msg = messages.history;
  const values = chart.flatMap((position) => (position.state === "RECORDED" ? [Number(position.valueMmolL)] : []));
  const axisMax = Math.max(10, Math.ceil(Math.max(0, ...values) / 5) * 5);
  const ticks = Array.from({ length: axisMax / 5 + 1 }, (_, index) => index * 5);
  const days = [...new Set(chart.map((position) => position.date))];
  const recordedCount = chart.filter((position) => position.state === "RECORDED").length;
  const descriptionId = `${headingId}-description`;

  return (
    <figure className="history-chart" aria-labelledby={headingId} aria-describedby={descriptionId}>
      <ul className="history-legend">
        <li>
          <span className="history-legend-swatch history-legend-swatch--recorded" aria-hidden="true" />
          {msg.recordedLegend}
        </li>
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
                .map((position) =>
                  position.state === "RECORDED" ? (
                    <span
                      key={position.position}
                      className="history-bar history-bar--recorded"
                      style={{ height: `${(Number(position.valueMmolL) / axisMax) * 100}%` }}
                    />
                  ) : (
                    <span key={position.position} className="history-bar history-bar--missing" />
                  ),
                )}
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
            {chart.map((position) => (
              <tr key={`${position.date}-${position.position}`}>
                <th scope="row">
                  {`${formatShortDate(locale, position.date)}${locale === "zh-SG" ? "" : " "}${msg.positionLabels[position.position]}`}
                </th>
                <td>{position.state === "RECORDED" ? position.valueMmolL : msg.notRecordedLegend}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
