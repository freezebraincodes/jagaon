import type { PrintObservation } from "@/application/care-preparation/care-preparation-contracts";

/**
 * Injected browser printing (plan 9C Task 4). It reports only what the
 * browser shows: a dialog is "opened" when the `beforeprint` event fires
 * during `window.print()`. It never claims anything was printed or shared.
 */
export type PrintPort = { print(): Promise<PrintObservation> };

type PrintTarget = Pick<Window, "print" | "addEventListener" | "removeEventListener">;

export function createBrowserPrintPort(target: PrintTarget | null = typeof window === "undefined" ? null : window): PrintPort {
  return Object.freeze({
    async print(): Promise<PrintObservation> {
      if (!target || typeof target.print !== "function") return "UNAVAILABLE";
      let opened = false;
      const onBeforePrint = () => {
        opened = true;
      };
      target.addEventListener("beforeprint", onBeforePrint);
      try {
        target.print();
      } catch {
        return "UNAVAILABLE";
      } finally {
        target.removeEventListener("beforeprint", onBeforePrint);
      }
      // Without the browser's own signal the result cannot be distinguished.
      return opened ? "DIALOG_OPENED" : "OUTCOME_UNKNOWN";
    },
  });
}
