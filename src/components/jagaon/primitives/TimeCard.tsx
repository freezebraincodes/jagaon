"use client";

import { useId, useState } from "react";
import type { ReadingTimeMessages } from "@/i18n/types";
import { shiftSingaporeDate, singaporeNowParts } from "../journal/singapore-time";
import { ChoiceGroup } from "./ChoiceGroup";
import { InputField } from "./Field";
import { ClockIcon, PencilIcon } from "./Icons";
import { TimeWheel } from "./TimeWheel";

type DayChoice = "TODAY" | "YESTERDAY" | "OTHER";

type TimeCardProps = {
  /** Accessible legend for the in-app time wheel. */
  label: string;
  /** Large summary line, e.g. "Today, 7:48 am". */
  summary: string;
  /** Optional hint under the summary. */
  hint?: string;
  editLabel: string;
  editorMessages: ReadingTimeMessages;
  type: "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  error?: string;
};

/**
 * v1 time summary card. Editing stays inside the app: the time is changed
 * through an inline listbox wheel, never a browser date/time picker.
 */
export function TimeCard({
  label,
  summary,
  hint,
  editLabel,
  editorMessages,
  type,
  value,
  onChange,
  error,
}: TimeCardProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [otherDay, setOtherDay] = useState(false);
  const open = editing || Boolean(error);
  const [date = "", time = ""] = type === "datetime-local" ? value.split("T") : ["", value];
  const today = singaporeNowParts().date;
  const yesterday = shiftSingaporeDate(today, -1);
  const day: DayChoice = otherDay
    ? "OTHER"
    : date === today
      ? "TODAY"
      : date === yesterday
        ? "YESTERDAY"
        : "OTHER";

  function changeDate(nextDate: string) {
    onChange(`${nextDate}T${time}`);
  }

  function changeTime(nextTime: string) {
    onChange(type === "datetime-local" ? `${date}T${nextTime}` : nextTime);
  }

  return (
    <div className={`time-card ${error ? "time-card--invalid" : ""}`.trim()}>
      <div className="time-card-summary">
        <ClockIcon size={30} className="icon time-card-icon" />
        <div className="time-card-text">
          <p className="time-card-value">{summary}</p>
          {hint ? <p className="time-card-hint">{hint}</p> : null}
        </div>
        <button
          type="button"
          className="text-link"
          aria-expanded={open}
          aria-controls={`${id}-editor`}
          onClick={() => setEditing((current) => !current)}
        >
          <PencilIcon size={18} />
          {editLabel}
        </button>
      </div>
      <div className="time-card-editor" id={`${id}-editor`} hidden={!open}>
        {type === "datetime-local" ? (
          <>
            <ChoiceGroup<DayChoice>
              legend={editorMessages.whichDay}
              variant="segmented"
              options={[
                { value: "TODAY", label: editorMessages.dayToday },
                { value: "YESTERDAY", label: editorMessages.dayYesterday },
                { value: "OTHER", label: editorMessages.dayOther },
              ]}
              value={day}
              onChange={(next) => {
                setOtherDay(next === "OTHER");
                if (next === "TODAY") changeDate(today);
                if (next === "YESTERDAY") changeDate(yesterday);
              }}
            />
            {day === "OTHER" ? (
              <InputField
                label={editorMessages.newDate}
                type="date"
                value={date}
                onChange={(event) => changeDate(event.target.value)}
                required
              />
            ) : null}
          </>
        ) : null}
        <TimeWheel
          legend={label}
          value={time}
          onChange={changeTime}
          messages={editorMessages}
          error={error}
        />
      </div>
    </div>
  );
}
