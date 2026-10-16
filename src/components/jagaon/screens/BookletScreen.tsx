"use client";

import { Fragment, useEffect, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { HistoryPeriod } from "@/application/history/recorded-history-contracts";
import { BOOKLET_COLUMNS, type BookletNote, type BookletQueryPort, type BookletView } from "@/application/booklet/booklet-query";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { formatSingaporeTime } from "../journal/singapore-time";
import { formatDateRange, formatShortDate } from "../history/history-format";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  booklet: BookletQueryPort | null;
};

const UNIT = "mmol/L";
const MEALS = ["BREAKFAST", "LUNCH", "DINNER"] as const;

/**
 * Owner decision 2026-10-16: the Booklet tab, laid out like a paper glucose diary. Rows are days (newest first); columns are before
 * and after each meal and bedtime, as she chose them; meals, medicines, activity and readings without a meal time are that day's notes
 * under the row. Read-only and descriptive: no colour by value, no target, no AI. A real table, so screen readers read each value with
 * its day and column.
 */
export function BookletScreen({ messages, locale, booklet }: Props) {
  const msg = messages.booklet;
  const [period, setPeriod] = useState<HistoryPeriod>("THIS_WEEK");
  const [attempt, setAttempt] = useState(0);
  // The loaded view is kept with the request it answers, so a new period or retry shows "loading" until its own answer arrives.
  const requestKey = `${period}:${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; view: BookletView } | null>(null);
  const view = loaded?.key === requestKey ? loaded.view : null;

  useEffect(() => {
    if (!booklet) return;
    let current = true;
    void booklet.load({ period }).then((next) => {
      if (current) setLoaded({ key: `${period}:${attempt}`, view: next });
    });
    return () => {
      current = false;
    };
  }, [booklet, period, attempt]);

  const time = (at: string | null) => (at === null ? msg.noTime : formatSingaporeTime(locale, at));
  const noteText = (note: BookletNote) =>
    note.kind === "READING"
      ? msg.noteReading(note.value, note.unit)
      : note.kind === "MEAL"
        ? note.label
        : note.kind === "ACTIVITY"
          ? msg.noteActivity(note.label, note.minutes)
          : msg.noteMedicine(note.name, note.state);

  return (
    <div className="booklet-screen">
      <h1 className="screen-title">{msg.title}</h1>
      <p className="booklet-intro">{msg.intro}</p>
      <ChoiceGroup
        legend={msg.title}
        legendHidden
        variant="segmented"
        value={period}
        onChange={(value) => setPeriod(value as HistoryPeriod)}
        options={[
          { value: "THIS_WEEK", label: messages.history.periodThisWeek },
          { value: "LAST_WEEK", label: messages.history.periodLastWeek },
          { value: "THIRTY_DAYS", label: messages.history.periodThirtyDays },
        ]}
      />

      {view === null ? (
        <p role="status" className="booklet-loading">
          {msg.loading}
        </p>
      ) : view.status === "UNAVAILABLE" ? (
        <section className="today-card booklet-state" aria-labelledby="booklet-unavailable-heading">
          <h2 id="booklet-unavailable-heading" className="card-title">
            {msg.unavailableTitle}
          </h2>
          <p>{msg.unavailableBody}</p>
          <button type="button" className="btn btn-outline btn-wide" onClick={() => setAttempt((value) => value + 1)}>
            {msg.retry}
          </button>
        </section>
      ) : (
        <div className="booklet-sheet">
          <table className="booklet-table">
            <caption>{msg.tableCaption(formatDateRange(locale, view.range.startDate, view.range.endDate), UNIT)}</caption>
            <colgroup>
              <col className="booklet-col-date" />
              {BOOKLET_COLUMNS.map((column) => (
                <col key={column} className={column === "BEDTIME" ? "booklet-col-bedtime" : "booklet-col-value"} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" rowSpan={2} className="booklet-date-head">
                  {msg.dateHeader}
                </th>
                {MEALS.map((meal) => (
                  <th key={meal} scope="colgroup" colSpan={2} className="booklet-meal-head">
                    {msg.mealGroups[meal]}
                  </th>
                ))}
                <th scope="col" rowSpan={2} className="booklet-meal-head booklet-bedtime-head">
                  {msg.bedtime}
                </th>
              </tr>
              <tr>
                {MEALS.flatMap((meal) =>
                  (["BEFORE", "AFTER"] as const).map((when) => (
                    <th key={`${meal}_${when}`} scope="col" className="booklet-when-head" aria-label={msg.columnNames[`${meal}_${when}`]}>
                      {when === "BEFORE" ? msg.before : msg.after}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            {view.days.map((day) => (
              <tbody key={day.date} className="booklet-day">
                <tr className="booklet-row">
                  <th scope="row" className="booklet-date">
                    {formatShortDate(locale, day.date)}
                  </th>
                  {BOOKLET_COLUMNS.map((column) => (
                    <td key={column} className="booklet-cell">
                      {day.readings[column].length === 0 ? (
                        <>
                          <span aria-hidden="true">–</span>
                          <span className="sr-only">{msg.notRecorded}</span>
                        </>
                      ) : (
                        day.readings[column].map((reading, index) => (
                          <Fragment key={index}>
                            <span className="booklet-value">
                              {reading.value}
                              {reading.unit === UNIT ? null : <span className="booklet-unit"> {reading.unit}</span>}
                            </span>
                            <span className="booklet-time">{time(reading.at)}</span>
                          </Fragment>
                        ))
                      )}
                    </td>
                  ))}
                </tr>
                {day.notes.length > 0 ? (
                  <tr className="booklet-notes-row">
                    <td colSpan={BOOKLET_COLUMNS.length + 1}>
                      <span className="booklet-notes-label">{msg.notesLabel}: </span>
                      {day.notes.map((note, index) => (
                        <span key={index} className={`booklet-note booklet-note--${note.kind.toLowerCase()}`}>
                          <span className="booklet-note-time">{time(note.at)}</span> {noteText(note)}
                        </span>
                      ))}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
