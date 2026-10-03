"use client";

import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import KeenSlider, { type KeenSliderInstance, type KeenSliderPlugin } from "keen-slider";
import type { ReadingTimeMessages } from "@/i18n/types";

const HOURS = Array.from({ length: 12 }, (_, index) => String(index + 1));
const MINUTES = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

type TimeWheelValue = {
  hour: string;
  minute: string;
  period: "am" | "pm";
};

type TimeWheelProps = {
  legend: string;
  value: string;
  onChange: (value: string) => void;
  messages: Pick<
    ReadingTimeMessages,
    "hourLabel" | "minuteLabel" | "periodLabel" | "am" | "pm" | "wheelHint"
  >;
  error?: string;
};

type WheelColumnProps = {
  label: string;
  values: readonly string[];
  value: string;
  onChange: (value: string) => void;
  displayValue?: (value: string) => string;
  loop?: boolean;
};

export function toTimeWheel(value: string): TimeWheelValue {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour24 = match ? Number(match[1]) : 0;
  const minute = match && Number(match[2]) < 60 ? match[2] : "00";
  const validHour = hour24 >= 0 && hour24 < 24 ? hour24 : 0;
  return {
    hour: String(validHour % 12 === 0 ? 12 : validHour % 12),
    minute,
    period: validHour >= 12 ? "pm" : "am",
  };
}

export function fromTimeWheel({ hour, minute, period }: TimeWheelValue): string {
  const hour24 = (Number(hour) % 12) + (period === "pm" ? 12 : 0);
  return `${String(hour24).padStart(2, "0")}:${minute}`;
}

/** Rows a looping wheel shows: previous, selected and next. */
const VISIBLE_ROWS = 3;
/**
 * Quiet gap that ends one mouse-wheel gesture (Keen Slider's wheel-controls
 * example uses 50 ms). It exceeds Keen's 200 ms release-velocity window, so a
 * wheel notch snaps to the nearest row and a trackpad's own momentum events
 * are not amplified by a second, Keen-generated fling.
 */
const WHEEL_GESTURE_END_MS = 250;
/**
 * Start of a synthetic wheel drag. Keen reads custom-event coordinates only
 * when they are non-zero and uses them only as deltas, so the gesture starts
 * far from zero rather than at the pointer's page position.
 */
const WHEEL_DRAG_ORIGIN = { x: 1, y: 1_000_000 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Keen Slider's mouse-wheel controls: wheel deltas are replayed as Keen drag
 * events, so a mouse wheel or trackpad shares the touch/mouse drag physics.
 */
const wheelControls: KeenSliderPlugin = (slider) => {
  let gestureEnd: ReturnType<typeof setTimeout> | undefined;
  let position = { x: 0, y: 0 };
  let active = false;

  function dispatch(name: "ksDragStart" | "ksDrag" | "ksDragEnd") {
    slider.container.dispatchEvent(new CustomEvent(name, { detail: { ...position } }));
  }

  function onWheel(event: globalThis.WheelEvent) {
    event.preventDefault();
    if (!active) {
      position = { ...WHEEL_DRAG_ORIGIN };
      dispatch("ksDragStart");
      // Keen spends the first move on its direction check, so it carries no distance.
      dispatch("ksDrag");
      active = true;
    }
    position = { x: position.x - event.deltaX, y: position.y - event.deltaY };
    dispatch("ksDrag");
    clearTimeout(gestureEnd);
    gestureEnd = setTimeout(() => {
      active = false;
      dispatch("ksDragEnd");
    }, WHEEL_GESTURE_END_MS);
  }

  slider.on("created", () => slider.container.addEventListener("wheel", onWheel, { passive: false }));
  slider.on("destroyed", () => {
    clearTimeout(gestureEnd);
    slider.container.removeEventListener("wheel", onWheel);
  });
};

/**
 * Keen measures its container when created and again only on window resize.
 * A wheel created inside a closed (hidden) time editor would keep a 1 px size,
 * so drags would be scaled wildly; re-measure whenever the column's box changes.
 */
const resizeControls: KeenSliderPlugin = (slider) => {
  let observer: ResizeObserver | undefined;
  slider.on("created", () => {
    if (typeof ResizeObserver === "undefined") return;
    let height = slider.container.getBoundingClientRect().height;
    observer = new ResizeObserver(() => {
      const next = slider.container.getBoundingClientRect().height;
      if (next > 0 && next !== height) {
        height = next;
        // update() stops any animation, so land on its target (e.g. a value
        // synchronised while the editor was closed) instead of mid-way.
        slider.update(undefined, slider.animator.targetIdx ?? undefined);
      }
    });
    observer.observe(slider.container);
  });
  slider.on("destroyed", () => observer?.disconnect());
};

/**
 * How Keen's track maps onto wheel rows, following Keen Slider's timepicker
 * example. A looping wheel shows three slides centred on the selection; the
 * two-value period wheel uses one full-height slide per value.
 */
function wheelGeometry(loop: boolean) {
  return loop
    ? { perView: VISIBLE_ROWS, offset: 1 / 2 - 1 / VISIBLE_ROWS / 2, dragSpeed: 1 }
    : { perView: 1, offset: 0, dragSpeed: VISIBLE_ROWS };
}

/** Signed rows between an option and the selection while the wheel is at rest. */
function restingRows(index: number, selected: number, length: number, loop: boolean): number {
  const rows = index - selected;
  if (!loop) return rows;
  return ((((rows + length / 2) % length) + length) % length) - length / 2;
}

/** Visual placement of an option `rows` away from the centre band. */
function rowStyle(rows: number): CSSProperties {
  const distance = Math.abs(rows);
  return {
    transform: `translateY(${(rows - 0.5) * 100}%)`,
    opacity: Math.max(0, 1 - distance / 2),
    pointerEvents: distance > 1.5 ? "none" : undefined,
  };
}

function paintRow(option: HTMLElement, rows: number) {
  const style = rowStyle(rows);
  option.style.transform = String(style.transform);
  option.style.opacity = String(style.opacity);
  option.style.pointerEvents = style.pointerEvents ?? "";
  option.dataset.centred = String(Math.abs(rows) < 0.5);
}

/** Places every option from Keen's track, the single source of each row's position. */
function paintWheel(slider: KeenSliderInstance, loop: boolean) {
  const details = slider.track.details;
  if (!details) return;
  const { perView, offset } = wheelGeometry(loop);
  const rows = slider.container.querySelectorAll<HTMLElement>('[role="option"]');
  details.slides.forEach((slide, index) => {
    const option = rows[index];
    if (option) paintRow(option, (slide.distance - offset) * perView);
  });
}

/**
 * One iOS-style wheel column. Keen Slider supplies the movement engine (touch
 * and mouse drag, inertia, snapping and looping); this component keeps the
 * listbox/option semantics, positions every option from Keen's track and
 * owns the controlled value. A value is emitted only when movement settles,
 * and an external value is moved into the wheel only when it differs from
 * the slide Keen is showing or heading to, so neither side can start an
 * update loop.
 */
function WheelColumn({
  label,
  values,
  value,
  onChange,
  displayValue = (item) => item,
  loop = true,
}: WheelColumnProps) {
  const id = useId();
  const currentIndex = Math.max(0, values.indexOf(value));
  const optionId = (index: number) => `${id}-option-${index}`;
  // Keen hooks run outside React renders, so they read the latest props here.
  const latest = useRef({ values, value, onChange });
  // True from a user drag until it settles, so a controlled update never fights a finger.
  const userMotion = useRef(false);

  useEffect(() => {
    latest.current = { values, value, onChange };
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const slider = useRef<KeenSliderInstance | null>(null);
  const length = values.length;

  // One Keen instance per mounted column, created and destroyed in pairs so a
  // remount (development double-mount, Fast Refresh) never leaves a second
  // engine driving the same rows.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { perView, dragSpeed } = wheelGeometry(loop);
    const reducedMotion = prefersReducedMotion();
    const paint = (instance: KeenSliderInstance) => paintWheel(instance, loop);

    function settle(instance: KeenSliderInstance) {
      userMotion.current = false;
      const details = instance.track.details;
      if (!details) return;
      const { values: current, value: selected, onChange: change } = latest.current;
      const next = current[details.rel];
      if (next !== undefined && next !== selected) change(next);
    }

    const { values: current, value: selected } = latest.current;
    const instance = new KeenSlider(
      container,
      {
        vertical: true,
        loop,
        initial: Math.max(0, current.indexOf(selected)),
        selector: null,
        slides: { number: length, perView, origin: loop ? "center" : "auto" },
        mode: reducedMotion ? "snap" : "free-snap",
        rubberband: !loop,
        dragSpeed,
        defaultAnimation: reducedMotion ? { duration: 0 } : undefined,
        created: paint,
        detailsChanged: paint,
        dragStarted: () => {
          userMotion.current = true;
        },
        // Keen queues its snap animation from its own dragEnded listener, setting
        // animator.targetIdx; when it queues none, the release is already at rest.
        dragEnded: (released) => {
          queueMicrotask(() => {
            if (released.animator.targetIdx === null) settle(released);
          });
        },
        animationEnded: settle,
      },
      [wheelControls, resizeControls],
    );
    slider.current = instance;
    return () => {
      instance.destroy();
      if (slider.current === instance) slider.current = null;
    };
  }, [loop, length]);

  // React renders resting positions for the server and first paint; once Keen
  // runs, a commit may rewrite some of those styles, so Keen's track repaints them.
  useLayoutEffect(() => {
    if (slider.current) paintWheel(slider.current, loop);
  });

  useEffect(() => {
    const instance = slider.current;
    if (!instance?.track.details || userMotion.current) return;
    const { animator, track } = instance;
    // Compare with where Keen is heading, so a running animation is retargeted
    // and a value Keen itself settled on is never moved again.
    const heading = animator.targetIdx === null ? track.details.rel : track.absToRel(animator.targetIdx);
    if (heading === currentIndex) return;
    instance.moveToIdx(currentIndex, false, prefersReducedMotion() ? { duration: 0 } : undefined);
  }, [currentIndex]);

  function selectIndex(index: number) {
    const bounded = loop
      ? (index + values.length) % values.length
      : Math.max(0, Math.min(values.length - 1, index));
    const next = values[bounded];
    if (next !== undefined && next !== value) onChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      selectIndex(currentIndex - 1);
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      selectIndex(currentIndex + 1);
    }
    if (event.key === "Home") {
      event.preventDefault();
      selectIndex(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      selectIndex(values.length - 1);
    }
  }

  return (
    <div
      ref={containerRef}
      className="keen-slider time-wheel-column"
      role="listbox"
      aria-label={label}
      aria-activedescendant={optionId(currentIndex)}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {values.map((option, index) => {
        const rows = restingRows(index, currentIndex, values.length, loop);
        return (
          <button
            key={option}
            id={optionId(index)}
            className={`time-wheel-option ${index === currentIndex ? "time-wheel-option--current" : ""}`.trim()}
            type="button"
            role="option"
            aria-selected={index === currentIndex}
            tabIndex={-1}
            data-centred={rows === 0}
            style={rowStyle(rows)}
            onClick={() => selectIndex(index)}
          >
            {displayValue(option)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * An always-inline, keyboard-operable time chooser built on Keen Slider
 * wheels, so no browser or operating-system date/time picker can appear.
 */
export function TimeWheel({ legend, value, onChange, messages, error }: TimeWheelProps) {
  const errorId = useId();
  const wheel = toTimeWheel(value);
  // Columns can settle in the same frame, before the parent re-renders; each
  // change merges into the latest emitted time so neither overwrites the other.
  const emitted = useRef(value);

  useEffect(() => {
    emitted.current = value;
  });

  function changed(next: Partial<TimeWheelValue>) {
    const time = fromTimeWheel({ ...toTimeWheel(emitted.current), ...next });
    emitted.current = time;
    onChange(time);
  }

  return (
    <fieldset
      className="time-wheel"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="eyebrow">{legend}</legend>
      <div className="time-wheel-band">
        <WheelColumn
          label={messages.hourLabel}
          values={HOURS}
          value={wheel.hour}
          onChange={(hour) => changed({ hour })}
        />
        <span className="time-wheel-colon" aria-hidden="true">
          :
        </span>
        <WheelColumn
          label={messages.minuteLabel}
          values={MINUTES}
          value={wheel.minute}
          onChange={(minute) => changed({ minute })}
        />
        <WheelColumn
          label={messages.periodLabel}
          values={["am", "pm"]}
          value={wheel.period}
          onChange={(period) => changed({ period: period as "am" | "pm" })}
          displayValue={(period) => (period === "am" ? messages.am : messages.pm)}
          loop={false}
        />
      </div>
      <p className="time-wheel-hint">{messages.wheelHint}</p>
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
