import { act } from "@testing-library/react";
import { vi } from "vitest";

/** Height of one wheel row in tests; a column shows three rows. */
export const WHEEL_ROW = 56;

/**
 * jsdom has no layout. Give each wheel column a three-row box so Keen Slider
 * converts drag distances into slides exactly as it does in a browser.
 * Restore with `vi.restoreAllMocks()`.
 */
export function stubWheelGeometry() {
  const size = (element: Element) =>
    element.classList.contains("time-wheel-column") ? { height: WHEEL_ROW * 3, width: 72 } : { height: 0, width: 0 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const { height, width } = size(this);
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, height, width, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return size(this).height;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return size(this).width;
  });
}

type KeenDragEvent = "ksDragStart" | "ksDrag" | "ksDragEnd";

/** Keen Slider's own drag input, carrying page coordinates in `detail`. */
export function keenDragEvent(target: HTMLElement, name: KeenDragEvent, y: number) {
  act(() => {
    target.dispatchEvent(new CustomEvent(name, { detail: { x: 1, y } }));
  });
}

export function pause(ms: number) {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/** Keen measures release velocity from moves in its last 200 ms. */
const KEEN_VELOCITY_WINDOW_MS = 200;

/**
 * A vertical drag through Keen Slider. Positive `rows` pull later values into
 * the centre. By default the finger rests before release, so Keen sees no
 * velocity and snaps to the nearest row; `fling` releases while moving, so
 * Keen's inertia carries the wheel further before it snaps.
 */
export async function dragWheel(target: HTMLElement, rows: number, { fling = false } = {}) {
  const start = 300;
  keenDragEvent(target, "ksDragStart", start);
  // Keen's first move only checks the drag direction.
  keenDragEvent(target, "ksDrag", start);
  for (let step = 1; step <= 6; step += 1) {
    if (fling) await pause(8);
    keenDragEvent(target, "ksDrag", start - (rows * WHEEL_ROW * step) / 6);
  }
  if (!fling) await pause(KEEN_VELOCITY_WINDOW_MS + 50);
  keenDragEvent(target, "ksDragEnd", start - rows * WHEEL_ROW);
}
