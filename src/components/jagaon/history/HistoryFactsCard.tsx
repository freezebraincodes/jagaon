"use client";

import { useId, type ReactNode } from "react";
import type { AppMessages } from "@/i18n/types";
import { DocumentIcon, InfoIcon } from "../primitives/Icons";

export type HistoryFact = {
  id: string;
  text: string;
  icon: ReactNode;
  /** Secondary descriptive lines (evidence window, correction provenance). */
  details?: string[];
};

type Props = {
  messages: AppMessages;
  rangeText: string;
  facts: readonly HistoryFact[];
  notes: readonly string[];
  selecting: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  children?: ReactNode;
};

/**
 * "What these records show": factual statements only, each with a stable
 * fact identifier for the user's own appointment-note selection.
 */
export function HistoryFactsCard({ messages, rangeText, facts, notes, selecting, selected, onToggle, children }: Props) {
  const msg = messages.history;
  const baseId = useId();
  return (
    <section className="today-card history-facts" aria-labelledby={`${baseId}-heading`}>
      <span className="history-tag">
        <DocumentIcon size={18} />
        {msg.recordedDataTag}
      </span>
      <h2 id={`${baseId}-heading`} className="card-title">
        {msg.factsTitle}
      </h2>
      <p className="history-range-small">{msg.periodRange(rangeText)}</p>
      <ul className="history-fact-list">
        {facts.map((fact, index) => {
          const textId = `${baseId}-fact-${index}`;
          const stateId = `${baseId}-state-${index}`;
          const body = (
            <span className="history-fact-body">
              <span id={textId}>{fact.text}</span>
              {fact.details?.map((detail) => (
                <span key={detail} className="history-fact-detail">
                  {detail}
                </span>
              ))}
            </span>
          );
          return (
            <li key={fact.id} className="history-fact">
              {selecting ? (
                <label className="history-fact-select">
                  <input
                    type="checkbox"
                    className="history-fact-checkbox"
                    checked={selected.has(fact.id)}
                    onChange={() => onToggle(fact.id)}
                    aria-labelledby={textId}
                    aria-describedby={stateId}
                  />
                  {body}
                  <span id={stateId} className="history-fact-state">
                    {selected.has(fact.id) ? msg.factSelected : msg.factNotSelected}
                  </span>
                </label>
              ) : (
                <>
                  <span className="history-fact-icon" aria-hidden="true">
                    {fact.icon}
                  </span>
                  {body}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {notes.map((note) => (
        <p key={note} className="history-note">
          <InfoIcon size={20} />
          <span>{note}</span>
        </p>
      ))}
      {children}
    </section>
  );
}
