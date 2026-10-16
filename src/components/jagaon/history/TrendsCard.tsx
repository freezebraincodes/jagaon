"use client";

import type { HistoryComparison } from "@/application/history/recorded-history-contracts";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { ChartIcon } from "../primitives/Icons";
import { formatDateRange } from "./history-format";
import { shownComparisons } from "./NoticeCard";

const UNIT = "mmol/L";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  comparisons: readonly HistoryComparison[];
};

/**
 * Owner decision 2026-10-16 (Trends): the same period comparison as Notice, drawn as two labelled bars per meal time (weeks 3 to 6,
 * then the last 2 weeks), with the exact dates and values written out. Read-only and descriptive (LRJ-002): neutral colours, bars from
 * zero, no target band, threshold line, risk colour, arrow or prediction. The bars repeat the text; screen readers get the text.
 * Shown only for comparisons that passed the evidence gate with a real difference. The screen's own "does not explain the cause" line
 * (under "What these records show") covers it, so it is not repeated here.
 */
export function TrendsCard({ messages, locale, comparisons }: Props) {
  const shown = shownComparisons(comparisons);
  if (shown.length === 0) return null;
  const msg = messages.history.trends;
  return (
    <section className="today-card trends-card" aria-labelledby="trends-heading">
      <h2 id="trends-heading" className="card-title trends-heading">
        <ChartIcon size={22} />
        {msg.title}
      </h2>
      <p className="trends-intro">{msg.intro}</p>
      {shown.map((comparison) => {
        const earlier = Number(comparison.reference);
        const recent = Number(comparison.recent);
        const top = Math.max(earlier, recent) || 1;
        const rows = [
          { key: "earlier", label: msg.earlier, range: comparison.referenceWindow, value: comparison.reference, width: (earlier / top) * 100 },
          { key: "recent", label: msg.recent, range: comparison.recentWindow, value: comparison.recent, width: (recent / top) * 100 },
        ];
        return (
          <figure key={comparison.factId} className="trends-figure">
            <figcaption className="trends-caption">
              <span className="trends-slot">{msg.slotTitles[comparison.slot]}</span>
              <span className="trends-measure"> · {comparison.kind === "VARIABILITY" ? msg.spread : msg.median}</span>
            </figcaption>
            <dl className="trends-rows">
              {rows.map((row) => (
                <div key={row.key} className={`trends-row trends-row--${row.key}`}>
                  <dt className="trends-label">
                    {row.label}
                    <span className="trends-dates">{formatDateRange(locale, row.range.startDate, row.range.endDate)}</span>
                  </dt>
                  <dd className="trends-value">
                    <span className="trends-bar" aria-hidden="true">
                      <span className="trends-bar-fill" style={{ width: `${Math.max(row.width, 2)}%` }} />
                    </span>
                    <span className="trends-number">{msg.value(row.value, UNIT)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </figure>
        );
      })}
    </section>
  );
}
