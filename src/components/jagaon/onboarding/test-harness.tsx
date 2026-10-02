import { render } from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import {
  createDemoOnboardingRepository,
  createMemoryOnboardingStorage,
  type DemoOnboardingRepository,
  type DemoOnboardingStoragePort,
} from "@/application/onboarding/demo-onboarding-repository";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import { OnboardingFlow, type OnboardingExit } from "./OnboardingFlow";

export const NOW = "2026-10-02T08:00:00.000Z";

/** Repository over an inspectable storage port; optionally fails N writes. */
export function testRepository(options: { failWrites?: number; initial?: Record<string, string> } = {}) {
  const backing = createMemoryOnboardingStorage(options.initial);
  let failuresLeft = options.failWrites ?? 0;
  const storage: DemoOnboardingStoragePort & { snapshot: () => Record<string, string> } = {
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new DOMException("quota", "QuotaExceededError");
      }
      backing.setItem(key, value);
      known.add(key);
    },
    removeItem: (key) => backing.removeItem(key),
    snapshot: () =>
      Object.fromEntries([...known].flatMap((key) => (backing.getItem(key) === null ? [] : [[key, backing.getItem(key)!]]))),
  };
  const known = new Set(Object.keys(options.initial ?? {}));
  const repository = createDemoOnboardingRepository(storage);
  const attempts: DemoOnboardingStateV1[] = [];
  const saves: DemoOnboardingStateV1[] = [];
  const spied: DemoOnboardingRepository = {
    load: () => repository.load(),
    save: (state) => {
      attempts.push(state);
      const result = repository.save(state);
      if (result.ok) saves.push(result.state);
      return result;
    },
    clear: () => repository.clear(),
  };
  return { repository: spied, storage, attempts, saves, failNext: (count: number) => (failuresLeft = count) };
}

function Harness({
  repository,
  initial,
  onExit,
}: {
  repository: DemoOnboardingRepository;
  initial: DemoOnboardingStateV1 | null;
  onExit: (exit: OnboardingExit) => void;
}) {
  const [locale, setLocale] = useState<SupportedLocale>(initial?.locale ?? "en-SG");
  let next = 0;
  return (
    <OnboardingFlow
      messages={getMessages(locale)}
      locale={locale}
      onLocaleChange={setLocale}
      repository={repository}
      initialState={initial}
      onExit={onExit}
      now={() => NOW}
      createId={() => `33333333-3333-4333-8333-33333333333${next++ % 10}`}
    />
  );
}

export function renderFlow(
  options: { initial?: DemoOnboardingStateV1 | null; failWrites?: number; storage?: Record<string, string> } = {},
) {
  const store = testRepository({ failWrites: options.failWrites, initial: options.storage });
  const onExit = vi.fn();
  const view = render(<Harness repository={store.repository} initial={options.initial ?? null} onExit={onExit} />);
  return { ...store, onExit, ...view };
}

export const persistedWithMedicine: DemoOnboardingStateV1 = {
  schemaVersion: 1,
  status: "IN_PROGRESS",
  lastCompletedStep: "ADD_MEDICINE",
  locale: "en-SG",
  preferredName: "Mdm Tan (demo)",
  medicines: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      catalogueKey: "nocturin-pen-demo",
      enteredName: "Nocturin pen (demo)",
      displayName: "Nocturin pen (demo)",
      genericName: "insulin glargine",
      form: null,
      strength: null,
      amountAndUnit: null,
      scheduleOrTiming: null,
      effectiveDate: null,
      verbatimDirections: null,
      source: "UNKNOWN",
      reviewedContentKey: "insulin-glargine",
    },
  ],
  updatedAt: NOW,
};
