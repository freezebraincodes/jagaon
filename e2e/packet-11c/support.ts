import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, type Locator, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { getMessages } from "@/i18n/get-messages";
import type { AppMessages } from "@/i18n/types";
import { shellTaskRequestSchema, slotToken, type ShellFieldPath, type ShellTaskRequest, type SlotPlan } from "@/domain/ai";
import { shellPlanView } from "@/application/ai/language/shell-projector";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { AI_SHELL_ACCESS_HEADER, aiShellAccessProbeResponseSchema, aiShellRouteResponseSchema, type AiShellRouteRefusalReason, type AiShellRouteResponse } from "@/application/ai/ai-shell-route-contract";
import { expectNoHorizontalOverflow } from "../packet-10/support";

/**
 * Packet 11C C7 browser-evidence helpers (synthetic data only; fake route bodies only; technical evidence, not owner approval).
 * The harness itself is documented in harness/harness-app.tsx. Everything here is parameterised by locale and viewport so later
 * packets can reuse it.
 */

export { expectNoHorizontalOverflow };

export const EVIDENCE_HEADER = "Technical evidence — not owner approval; presentation remains human acceptance pending.";
/** Set once by playwright.packet-11c.config.ts (inherited by the workers). */
export const EVIDENCE_DIR = process.env.C7_EVIDENCE_DIR ?? join(process.cwd(), "test-results/packet-11c-browser-evidence/unset");
export const PRODUCTION_URL = "http://localhost:3311";
export const HARNESS_URL = "http://localhost:3312";
/** The synthetic demo passcode the fake route accepts (8 to 128 visible ASCII, like the real route). Never a real secret. */
export const SYNTHETIC_PASSCODE = "c7-synthetic-demo-pass";

export const LOCALES = ["en-SG", "zh-SG"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * The viewports. 200% zoom is emulated as a 640 CSS-px-wide viewport at deviceScaleFactor 2: the 1280 px desktop window at 200%
 * browser zoom (what page zoom does to the CSS viewport width), rendered at twice the pixel density.
 */
export const VIEWPORTS = {
  mobile: { label: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
  desktop: { label: "1280", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  zoom200: { label: "200pct", viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
} as const;
export type ViewportKey = keyof typeof VIEWPORTS;

export const messagesFor = (locale: Locale): AppMessages => getMessages(locale);

// ---- Navigation over the real UI (synthetic data: the prepared demo profile plus the runtime's synthetic seed) -------------------

/**
 * Welcome → "Use the prepared demo profile", then the language is set on the More screen once the dataset is open (the Settings
 * checkbox is enabled only then), as Packet 10 does, so every test starts from the same opened dataset in both locales. The Welcome
 * language path (C7 finding D1, fixed in fix round 1) is checked on its own in production.spec.ts.
 */
export async function startPreparedProfile(page: Page, baseUrl: string, locale: Locale, query = ""): Promise<AppMessages> {
  const m = messagesFor(locale);
  const en = messagesFor("en-SG");
  await page.goto(`${baseUrl}/${query}`);
  await page.getByRole("button", { name: en.onboarding.usePrepared }).click();
  await expect(page.getByRole("button", { name: en.today.recordReading })).toBeVisible();
  await openTab(page, en.shared.navMore);
  await expect(page.getByRole("checkbox", { name: en.aiWording.keepOnDeviceLabel })).toBeEnabled();
  const language = page.getByRole("group", { name: en.settings.language }).getByRole("button", { name: m.settings[locale === "en-SG" ? "english" : "chinese"] });
  await language.click();
  await expect(page.getByRole("button", { name: m.settings[locale === "en-SG" ? "english" : "chinese"], pressed: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: m.more.title })).toBeVisible();
  await openTab(page, m.shared.navToday);
  await expect(page.getByRole("button", { name: m.today.recordReading })).toBeVisible();
  return m;
}

/** Opens a bottom-navigation tab; from a child screen (no navigation shown) it first goes back to the top level. */
export async function openTab(page: Page, name: string): Promise<void> {
  for (let step = 0; step < 4 && (await page.getByRole("navigation").count()) === 0; step += 1) {
    await page.locator("main").getByRole("button").first().click();
  }
  await page.getByRole("navigation").getByRole("button", { name }).click();
}

export async function openHistory(page: Page, m: AppMessages): Promise<Locator> {
  await openTab(page, m.shared.navHistory);
  await expect(page.getByRole("heading", { level: 1, name: m.history.title })).toBeVisible();
  // The prepared demo data ends yesterday (owner instruction 2026-10-12), so "This week" holds no reading on a Monday; "Last week"
  // always does, whatever the day or time the test runs.
  await page.getByRole("radio", { name: m.history.periodLastWeek }).check({ force: true });
  await expect(page.getByRole("radio", { name: m.history.periodLastWeek })).toBeChecked();
  const action = page.getByRole("button", { name: m.history.explanation.action }).first();
  await expect(action).toBeVisible();
  return action;
}

/**
 * Today → "Prepare for appointment" → tick one record group → "Preview summary". The harness uses the insulin records (10 records): a
 * care request within the remote budget, so its class can be qualified. The glucose readings of the prepared demo data's 14-day visit
 * period (11 readings; owner instruction 2026-10-12) make a remote-eligible request of a class outside the evaluated classes
 * (NO_DEFINITION); the owner demo override (owner decision 2026-10-12) admits it in en-SG, so the AI action is offered there, never in zh-SG.
 */
export async function openCarePreview(page: Page, m: AppMessages, group: "glucoseReadings" | "insulinRecords" = "glucoseReadings"): Promise<Locator> {
  await openTab(page, m.shared.navToday);
  await page.getByRole("button", { name: m.today.prepareAppointment }).click();
  await page.getByRole("checkbox", { name: new RegExp(m.carePreparation[group]) }).check();
  await page.getByRole("button", { name: m.carePreparation.previewSummary }).click();
  await expect(page.getByRole("heading", { level: 1, name: m.careSummary.title })).toBeVisible();
  const article = page.locator("article.printable-care-summary");
  await expect(article).toBeVisible();
  return article;
}

export async function openSettings(page: Page, m: AppMessages): Promise<void> {
  await openTab(page, m.shared.navMore);
  await expect(page.getByRole("checkbox", { name: m.aiWording.keepOnDeviceLabel })).toBeVisible();
}

/** Turns "Keep wording on this device" on or off on the More screen (C2) and waits until the stored value shows. */
export async function setKeepWordingOnDevice(page: Page, m: AppMessages, on: boolean): Promise<void> {
  await openSettings(page, m);
  const box = page.getByRole("checkbox", { name: m.aiWording.keepOnDeviceLabel });
  await expect(box).toBeEnabled();
  if (on) await box.check();
  else await box.uncheck();
  await expect(box).toBeChecked({ checked: on });
}

/** Replaces window.print so the print attempt is observable without a native dialog (the browser print port sees `beforeprint`). */
export async function stubWindowPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as { print: () => void; __c7PrintCalls?: number };
    target.__c7PrintCalls = 0;
    target.print = () => {
      target.__c7PrintCalls = (target.__c7PrintCalls ?? 0) + 1;
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
    };
  });
}

// ---- Fake POST /api/ai/shell (route interception; bodies typed and checked by the shared route contract) ----------------------

export type FakeShellAnswer =
  /** A CANDIDATE built for the intercepted value-blind request, with fake wording that passes the browser's local gates. */
  | Readonly<{ kind: "ACCEPT" }>
  /** STRUCTURALLY_REJECTED (SCHEMA_INVALID, repairable) for the first call, then ACCEPT for the single repair. */
  | Readonly<{ kind: "REPAIR_THEN_ACCEPT" }>
  /** STRUCTURALLY_REJECTED with a reason that is never repaired. */
  | Readonly<{ kind: "REJECT_UNREPAIRABLE" }>
  /** FAILED after a provider call (with its upper-bound usage), or before one (`notSentToProvider`). */
  /** Owner decision 2026-10-12 (AI credit dialog): OPERATIONAL_SPEND_LOCKED is the route's answer to DeepSeek's HTTP 402 (balance used up). */
  | Readonly<{ kind: "FAILED"; reason: "PROVIDER_FAILED" | "PROVIDER_TIMEOUT" | "MISSING_CONFIGURATION" | "OPERATIONAL_SPEND_LOCKED"; notSent?: boolean }>
  /** A 403 REFUSED with its closed reason (switch, origin, access, spend). */
  | Readonly<{ kind: "REFUSED"; reason: AiShellRouteRefusalReason }>
  /** Held until `release()` (or the browser aborts it), then ACCEPT. */
  | Readonly<{ kind: "HOLD_THEN_ACCEPT" }>;

export type ShellCall = Readonly<{ at: number; taskType: string; locale: string; passcodeHeader: string | null; body: string; answered: string }>;

const usage = { inputTokens: 900, outputTokens: 120, costMicroUsd: 420 };

const EXPLAIN_WORDING = {
  "en-SG": { headline: (t: string) => `A look at ${t}.`, evidence: (t: string) => `This is based on ${t}.`, evidenceNone: "This is based on your recorded information." },
  "zh-SG": { headline: (t: string) => `本说明关注的是${t}。`, evidence: (t: string) => `本说明依据${t}。`, evidenceNone: "本说明依据您的记录信息。" },
} as const;
/**
 * Care bullets are fragments without sentence-final punctuation, like the approved default shells (the tokens alone): the app places a
 * bullet inside a line (e.g. the appointment line is `bullet · time`, ai-care-summary-request.ts:115), so a fake full stop would show
 * as "… 2026. · 9:40 am" (fix round 1, U14: that stray "." came from this fake text).
 */
const CARE_WORDING = {
  "en-SG": { intro: "Here are the details you chose to include:", bullet: (t: readonly string[]) => `You recorded ${t.join(", ")}` },
  "zh-SG": { intro: "以下是您选择加入的信息：", bullet: (t: readonly string[]) => `您记录了${t.join("，")}` },
} as const;

/** How an accepted fake AI headline starts, per locale (the deterministic one starts with the language copy's default instead). */
export const AI_HEADLINE_PREFIX: Readonly<Record<Locale, string>> = { "en-SG": "A look at", "zh-SG": "本说明关注的是" };
export const DETERMINISTIC_HEADLINE_PREFIX: Readonly<Record<Locale, string>> = {
  "en-SG": AI_LANGUAGE_COPY.explainDefaults["en-SG"].headline.split("{meaning}")[0]!.trim(),
  "zh-SG": AI_LANGUAGE_COPY.explainDefaults["zh-SG"].headline.split("{meaning}")[0]!.trim(),
};
/** Closed codes that must never be shown to the patient. */
export const TECHNICAL_CODES = ["ACCESS_DENIED", "REMOTE_AI_DISABLED", "SPEND_CEILING_REACHED", "PROVIDER_FAILED", "PROVIDER_TIMEOUT", "SCHEMA_INVALID", "CLINICAL_MEANING_VIOLATION", "PROVIDER_REJECTED", "STRUCTURALLY_REJECTED"];

/** Fake model wording for every model-owned field of the plan (distinct from the deterministic default shells). */
export function fakeShellTexts(plan: SlotPlan): Map<ShellFieldPath, string> {
  const locale = plan.locale as Locale;
  const tokensOf = (path: ShellFieldPath) => (plan.fields.find((field) => field.path === path)?.requiredSlots ?? []).map(slotToken);
  const texts = new Map<ShellFieldPath, string>();
  if (plan.taskType === "EXPLAIN_PATTERN") {
    const w = EXPLAIN_WORDING[locale];
    texts.set("headline", w.headline(tokensOf("headline").join(locale === "zh-SG" ? "，" : ", ")));
    const evidence = tokensOf("evidence");
    texts.set("evidence", evidence.length > 0 ? w.evidence(evidence.join(locale === "zh-SG" ? "，" : ", ")) : w.evidenceNone);
    return texts;
  }
  const w = CARE_WORDING[locale];
  for (const section of plan.sections) {
    texts.set(section.introPath, w.intro);
    for (const path of section.bulletPaths) texts.set(path, w.bullet(tokensOf(path)));
  }
  return texts;
}

function candidateFor(request: ShellTaskRequest): AiShellRouteResponse {
  const plan = shellPlanView(request);
  return { kind: "CANDIDATE", candidate: shellCandidate(plan, fakeShellTexts(plan)) as never, retention: "CONFIRMED_NOT_STORED", usage };
}

export type FakeShellRoute = Readonly<{
  calls: ShellCall[];
  /** Owner decision 2026-10-12 (optional passcodes): the passcode probes (GET /api/ai/shell) answered, never counted in `calls`. */
  probes: number[];
  /** Answers the browser no longer waited for (it aborted the request first). */
  aborted: string[];
  /** Sets the answer for the following calls (default ACCEPT). */
  answer(next: FakeShellAnswer): void;
  /** Releases every held call (HOLD_THEN_ACCEPT). */
  release(): void;
  /** Resolves once at least `count` calls arrived. */
  waitForCalls(count: number): Promise<void>;
}>;

/**
 * Intercepts every POST /api/ai/shell of this page with a fake, contract-checked answer. Like the real route, a request without the
 * synthetic passcode header is refused ACCESS_DENIED (403) when `requirePasscode` is set (the default). Nothing reaches a server.
 * Owner decision 2026-10-12 (optional passcodes): the passcode probe (GET /api/ai/shell) is answered `{ passcodeRequired }` with the
 * same option, so `requirePasscode: false` plays a deployment with no JAGAON_AI_DEMO_PASSCODE (no passcode field, no header sent).
 */
export async function interceptShellRoute(page: Page, options: { requirePasscode?: boolean } = {}): Promise<FakeShellRoute> {
  const requirePasscode = options.requirePasscode ?? true;
  const calls: ShellCall[] = [];
  const probes: number[] = [];
  const aborted: string[] = [];
  let next: FakeShellAnswer = { kind: "ACCEPT" };
  let repairPending = false;
  const held: Array<() => void> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (calls.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const fulfil = async (route: Route, status: number, body: AiShellRouteResponse) => {
    // Every fake body must conform exactly to the shared route contract (the browser parses it strictly too).
    aiShellRouteResponseSchema.parse(body);
    try {
      await route.fulfill({ status, contentType: "application/json; charset=utf-8", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    } catch {
      // The browser aborted the request (Cancel, a new request, a locale or view change): nothing to answer.
    }
  };
  // A request the browser itself aborted (its AbortSignal fired) is reported as failed by the page.
  page.on("requestfailed", (request) => {
    if (/\/api\/ai\/shell$/.test(new URL(request.url()).pathname)) aborted.push(request.failure()?.errorText ?? "failed");
  });
  await page.route("**/api/ai/shell", async (route: Route, request: Request) => {
    if (request.method() === "GET") {
      probes.push(Date.now());
      const probe = aiShellAccessProbeResponseSchema.parse({ passcodeRequired: requirePasscode });
      try {
        await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", headers: { "cache-control": "no-store" }, body: JSON.stringify(probe) });
      } catch {
        // The page went away: nothing to answer.
      }
      return;
    }
    const body = request.postData() ?? "";
    const parsed = shellTaskRequestSchema.parse(JSON.parse(body));
    const passcodeHeader = (await request.allHeaders())[AI_SHELL_ACCESS_HEADER] ?? null;
    const answer = repairPending ? ({ kind: "ACCEPT" } as const) : next;
    const record = (answered: string) => {
      calls.push({ at: Date.now(), taskType: parsed.taskType, locale: parsed.locale, passcodeHeader, body, answered });
      notify();
    };
    if (request.method() !== "POST") return void (await route.abort());
    if (requirePasscode && passcodeHeader !== SYNTHETIC_PASSCODE) {
      record("REFUSED:ACCESS_DENIED");
      return fulfil(route, 403, { kind: "REFUSED", reason: "ACCESS_DENIED", notSentToProvider: true });
    }
    switch (answer.kind) {
      case "ACCEPT":
        repairPending = false;
        record("CANDIDATE");
        return fulfil(route, 200, candidateFor(parsed));
      case "REPAIR_THEN_ACCEPT":
        repairPending = true;
        record("STRUCTURALLY_REJECTED:SCHEMA_INVALID");
        return fulfil(route, 200, { kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage });
      case "REJECT_UNREPAIRABLE":
        record("STRUCTURALLY_REJECTED:CLINICAL_MEANING_VIOLATION");
        return fulfil(route, 200, { kind: "STRUCTURALLY_REJECTED", reason: "CLINICAL_MEANING_VIOLATION", repairable: false, retention: "CONFIRMED_NOT_STORED", usage });
      case "FAILED":
        record(`FAILED:${answer.reason}`);
        return fulfil(route, 200, answer.notSent ? { kind: "FAILED", reason: answer.reason, notSentToProvider: true } : { kind: "FAILED", reason: answer.reason, usage: { ...usage, basis: "UPPER_BOUND" } });
      case "REFUSED":
        record(`REFUSED:${answer.reason}`);
        return fulfil(route, 403, { kind: "REFUSED", reason: answer.reason, notSentToProvider: true });
      case "HOLD_THEN_ACCEPT":
        record("HELD");
        await new Promise<void>((resolve) => held.push(resolve));
        return fulfil(route, 200, candidateFor(parsed));
    }
  });
  return {
    calls,
    probes,
    aborted,
    answer: (value) => {
      next = value;
      repairPending = false;
    },
    release: () => {
      for (const resolve of held.splice(0)) resolve();
    },
    waitForCalls: (count) => (calls.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))),
  };
}

/**
 * Production tripwire: any request to /api/ai/* fails the test (recorded and aborted). `assertUntouched()` is called at the end.
 */
export async function shellTripwire(page: Page): Promise<{ hits: string[]; assertUntouched(): void }> {
  const hits: string[] = [];
  await page.route("**/api/ai/**", async (route) => {
    hits.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  page.on("request", (request) => {
    if (/\/api\/ai\//.test(request.url()) && !hits.includes(`${request.method()} ${request.url()}`)) hits.push(`${request.method()} ${request.url()}`);
  });
  return { hits, assertUntouched: () => expect(hits, "the production app must never call /api/ai/*").toEqual([]) };
}

// ---- Accessibility helpers (Playwright role queries and aria snapshots only) ---------------------------------------------------

/** The accessible names of the elements focused by `count` presses of Tab (or Shift+Tab). */
/**
 * The keys that move focus through buttons as well as fields. WebKit follows Safari's default ("Press Tab to highlight each item" off):
 * Tab skips buttons and Option+Tab includes them, so WebKit uses Alt+Tab (the app sees key "Tab" either way).
 */
export function tabKeys(browserName: string): { next: string; previous: string } {
  return browserName === "webkit" ? { next: "Alt+Tab", previous: "Alt+Shift+Tab" } : { next: "Tab", previous: "Shift+Tab" };
}

export async function focusSequence(page: Page, count: number, key = "Tab"): Promise<string[]> {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press(key);
    names.push(await page.evaluate(() => describeActive()));
  }
  return names;
}

/** Installs `describeActive()` (role|name of document.activeElement) in every page of the context. */
export async function installFocusProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { describeActive: () => string }).describeActive = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "body|";
      const role = el.getAttribute("role") ?? (el.tagName === "INPUT" ? `input:${(el as HTMLInputElement).type}` : el.tagName.toLowerCase());
      const labelled = el.getAttribute("aria-label") ?? (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.closest("label")?.textContent ?? el.textContent ?? "";
      return `${role}|${labelled.replace(/\s+/g, " ").trim()}`;
    };
    // Every focus move, in order (`focusLog()`), so a transient focus return is observable too.
    const log: string[] = [];
    (window as unknown as { focusLog: () => string[] }).focusLog = () => [...log];
    document.addEventListener("focusin", () => log.push((window as unknown as { describeActive: () => string }).describeActive()), true);
  });
}
declare global {
  function describeActive(): string;
  function focusLog(): string[];
}

/** The focus moves recorded since the page loaded (role|name each). */
export async function focusMoves(page: Page): Promise<string[]> {
  return page.evaluate(() => focusLog());
}

/** Presses `key` `presses` times and asserts focus stays inside `selector` each time; returns the focused names. */
export async function expectFocusTrapped(page: Page, selector: string, presses: number, key: string): Promise<string[]> {
  const names: string[] = [];
  for (let index = 0; index < presses; index += 1) {
    await page.keyboard.press(key);
    const probe = await page.evaluate((scope) => ({ inside: document.activeElement?.closest(scope) !== null && document.activeElement !== null, name: describeActive() }), selector);
    expect(probe.inside, `${key} #${index + 1} left ${selector} (focus on ${probe.name})`).toBe(true);
    names.push(probe.name);
  }
  return names;
}

/** The focused element's role|name. */
export async function activeName(page: Page): Promise<string> {
  return page.evaluate(() => describeActive());
}

/** True when the focused element draws a visible focus indicator (outline or box-shadow). */
export async function focusIndicatorVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
    const shadow = style.boxShadow !== "none" && style.boxShadow !== "";
    return outline || shadow;
  });
}

/** Every value held in localStorage, sessionStorage and every IndexedDB database of the page, as one string (for absence checks). */
export async function allBrowserStorage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [{ name: "jagaon" }];
    for (const info of databases) {
      if (!info.name) continue;
      parts.push(
        await new Promise<string>((resolve, reject) => {
          const open = indexedDB.open(info.name!);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const database = open.result;
            const names = [...database.objectStoreNames];
            if (names.length === 0) {
              database.close();
              return resolve("");
            }
            const transaction = database.transaction(names, "readonly");
            const rows: unknown[] = [];
            for (const name of names) {
              const all = transaction.objectStore(name).getAll();
              all.onsuccess = () => rows.push(...all.result);
            }
            transaction.oncomplete = () => {
              database.close();
              resolve(JSON.stringify(rows));
            };
          };
        }),
      );
    }
    return parts.join("\n");
  });
}

// ---- Evidence recording -------------------------------------------------------------------------------------------------------

export type EvidenceTarget = "production" | "harness";
export type EvidenceContext = Readonly<{ target: EvidenceTarget; locale: Locale; viewport: string; engine: string }>;

const RECORDS = () => join(EVIDENCE_DIR, "records.jsonl");
function writeRecord(record: Record<string, unknown>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(RECORDS(), `${JSON.stringify(record)}\n`);
}

/** Declares the states a test intends to capture, so a state it never reaches is reported NOT CAPTURED (never a silent pass). */
export function planStates(testInfo: TestInfo, context: EvidenceContext, states: readonly string[]): void {
  writeRecord({ kind: "PLAN", testId: testInfo.testId, title: testInfo.title, ...context, states });
}

/**
 * Records one state AFTER its checks passed: a full-page screenshot, an optional aria snapshot of `scope`, and the list of checks.
 */
export async function captureState(page: Page, testInfo: TestInfo, context: EvidenceContext, state: string, checks: readonly string[], scope?: Locator): Promise<void> {
  const base = `${context.target}-${state}-${context.locale}-${context.viewport}`;
  const dir = join(EVIDENCE_DIR, context.engine);
  mkdirSync(dir, { recursive: true });
  const screenshot = join(dir, `${base}.png`);
  // A full-page capture misplaces a fixed modal sheet, so a state with an open dialog is captured as the viewport the person sees.
  const modalOpen = (await page.locator("[role=dialog]").count()) > 0;
  // Fix round 1: in a full-page capture the fixed bottom navigation would be drawn mid-page over the content, so it is hidden there
  // (screenshot-only CSS; the page itself is unchanged). The viewport capture of an open modal keeps it, as the person sees it.
  await page.screenshot({ path: screenshot, fullPage: !modalOpen, ...(modalOpen ? {} : { style: ".app-nav { visibility: hidden !important; }" }) });
  let aria: string | null = null;
  if (scope) {
    aria = join(dir, `${base}.aria.yml`);
    writeFileSync(aria, await scope.ariaSnapshot());
  }
  writeRecord({ kind: "STATE", testId: testInfo.testId, title: testInfo.title, ...context, state, checks: [...checks, modalOpen ? "screenshot: viewport (modal open)" : "screenshot: full page, fixed bottom navigation hidden in the capture only"], screenshot: relative(EVIDENCE_DIR, screenshot), aria: aria ? relative(EVIDENCE_DIR, aria) : null });
}

/** A state that could not be captured, with the reason. Never a pass. */
export function notCaptured(testInfo: TestInfo, context: EvidenceContext, state: string, reason: string): void {
  writeRecord({ kind: "NOT_CAPTURED", testId: testInfo.testId, title: testInfo.title, ...context, state, reason });
}

/** Extra evidence files (e.g. a printed PDF). */
export function evidencePath(context: EvidenceContext, name: string): string {
  const dir = join(EVIDENCE_DIR, context.engine);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${context.target}-${name}-${context.locale}-${context.viewport}`);
}

/** Called from each spec's afterEach: the test's final status. */
export function recordTestResult(testInfo: TestInfo): void {
  writeRecord({ kind: "TEST", testId: testInfo.testId, title: testInfo.title, project: testInfo.project.name, status: testInfo.status, expectedStatus: testInfo.expectedStatus, durationMs: testInfo.duration, error: testInfo.error?.message?.split("\n")[0] ?? null });
}
