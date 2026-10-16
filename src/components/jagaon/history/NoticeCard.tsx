"use client";

import type { HistoryComparison } from "@/application/history/recorded-history-contracts";
import type { AppMessages } from "@/i18n/types";
import { ChevronRightIcon, HistoryIcon } from "../primitives/Icons";

/** A comparison with a real difference and both values (the governed evidence gate already passed). */
export type ShownComparison = HistoryComparison & { recent: string; reference: string };

export function shownComparisons(comparisons: readonly HistoryComparison[]): ShownComparison[] {
  return comparisons.filter((comparison): comparison is ShownComparison => comparison.kind !== "NO_MATERIAL" && comparison.recent !== null && comparison.reference !== null);
}

/** One plain sentence for a comparison: higher, lower, or varied more or less. Never a cause, a judgement or an action. */
export function noticeSentence(messages: AppMessages, comparison: ShownComparison): string {
  const notice = messages.history.notice;
  const slot = notice.slots[comparison.slot];
  if (comparison.kind === "HIGHER") return notice.higher(slot);
  if (comparison.kind === "LOWER") return notice.lower(slot);
  return Number(comparison.recent) > Number(comparison.reference) ? notice.variedMore(slot) : notice.variedLess(slot);
}

/** What the Today card shows: nothing while loading or unavailable; otherwise the comparisons, possibly none. */
export type NoticeView = Readonly<{ comparisons: readonly HistoryComparison[] }> | null;

type Props = {
  messages: AppMessages;
  notice: NoticeView;
  onOpenHistory?: () => void;
};

/**
 * Owner decision 2026-10-16 (Notice): a short, rule-based observation on Today. It compares her own readings at the same meal time,
 * the last 2 weeks against weeks 3 to 6, and shows a plain sentence only when the governed evidence gate found enough readings in both
 * periods and a real difference. Otherwise it says there are not enough readings yet. It reads only stored readings, draws no chart,
 * gives no cause and recommends nothing.
 */
export function NoticeCard({ messages, notice, onOpenHistory }: Props) {
  if (notice === null) return null;
  const msg = messages.history.notice;
  const shown = shownComparisons(notice.comparisons);
  return (
    <section className="today-card notice-card" aria-labelledby="notice-heading">
      <h2 id="notice-heading" className="eyebrow notice-heading">
        <HistoryIcon size={20} />
        {msg.title}
      </h2>
      {shown.length > 0 ? (
        <ul className="notice-list">
          {shown.map((comparison) => (
            <li key={comparison.factId} className="notice-sentence">
              {noticeSentence(messages, comparison)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="notice-sentence notice-sentence--quiet">{msg.notEnough}</p>
      )}
      <p className="provenance-line">{messages.history.nonCausalLimitation}</p>
      {onOpenHistory ? (
        <button type="button" className="text-link" onClick={onOpenHistory}>
          {msg.open}
          <ChevronRightIcon size={18} />
        </button>
      ) : null}
    </section>
  );
}
