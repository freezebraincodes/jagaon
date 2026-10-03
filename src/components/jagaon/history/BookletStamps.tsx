"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { HistoryProjection } from "@/application/history/recorded-history-contracts";
import { CheckIcon } from "../primitives/Icons";
import { formatShortDate } from "./history-format";

type Props = { messages: AppMessages; locale: SupportedLocale; stamps: HistoryProjection["stamps"] };

/** Booklet stamps: logging completion only, never a statement about values. */
export function BookletStamps({ messages, locale, stamps }: Props) {
  const msg = messages.history;
  return (
    <section className="today-card history-stamps" aria-labelledby="history-booklet-heading">
      <div className="history-stamps-header">
        <h2 id="history-booklet-heading" className="card-title">
          {msg.bookletTitle}
        </h2>
        <span className="history-stamps-only">{msg.bookletOnly}</span>
      </div>
      <ul className="history-stamp-list">
        {stamps.map((stamp) => {
          const date = formatShortDate(locale, stamp.date);
          return (
            <li key={stamp.date}>
              <span
                role="img"
                className={`history-stamp ${stamp.complete ? "history-stamp--complete" : "history-stamp--incomplete"}`}
                aria-label={stamp.complete ? msg.completeStamp(date) : msg.incompleteStamp(date, stamp.recordedPositions)}
              >
                {stamp.complete ? <CheckIcon size={22} /> : <span aria-hidden="true">–</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="history-stamps-note">{msg.bookletExplanation}</p>
    </section>
  );
}
