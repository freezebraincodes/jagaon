import { DEEPSEEK_RESPONSES_PROFILE } from "@/ai/deepseek/deepseek-responses-provider";
import { SHELL_PROVIDER_SCHEMA_VERSION, shellOutputJsonSchema, shellOutputSchemaName } from "@/ai/kie/kie-shell-contracts";
import { PACKET_11_SHELL_PROMPT_VERSION, PACKET_11_SHELL_PROMPTS } from "@/ai/prompts/packet-11-shell-prompts";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { SHELL_RULES_REVISION } from "@/application/ai/language/shell-lexicon";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_REQUEST_CLASS_SCHEME, type AiRequestClassContractInputs, type AiRequestClassDefinition } from "@/application/ai/request-class-definitions";
import { requestClassId, shellRequestDigest } from "@/application/ai/request-class-qualification";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { sha256Hex } from "@/application/intelligence/metrics";
import { AI_LOCALES, SHELL_INPUT_VERSIONS, SHELL_MAX_OUTPUT_TOKENS, SHELL_OUTPUT_VERSIONS, SHELL_PROVIDER_REQUEST_VERSION, SHELL_TASKS, SHELL_TEMPERATURE, SLOT_PLAN_VERSION, type ShellTask, type ShellTaskRequest } from "@/domain/ai";
import { VALIDATOR_RULES_REVISION } from "./packet-11-evaluation";
import { APPROVED_HYBRID_CONTRACT } from "./packet-11-hybrid-evaluation";
import { hybridFixturesForPhase } from "./packet-11-hybrid-fixtures";

/**
 * Packet 11C Addendum C, Task C1 (evaluation-only; never imported by product code). Generates the immutable request-class definitions
 * module `src/application/ai/request-class-definitions.ts` from the FROZEN sources, so that the product module itself is plain data and
 * imports no evaluation, prompt or provider code:
 * - the contract inputs are read from the code that carries them (the prompt assets and the provider output schemas are server-only, so
 *   the browser-safe module carries only their digests, exactly as the B5 contract freeze computes them);
 * - the classes come from running the frozen request builders (planSlots + projectShellTaskRequest, the bytes the route sends) over the
 *   70 FULL fixtures. A class is one distinct projected value-blind ShellTaskRequest; its `sampleFixtureIds` are the FULL fixtures whose
 *   projected request (and so model-facing body) is identical. "Samples" means only that: fixtures sharing one identical body. It never
 *   means the model saw a fixture's patient text (none crosses the boundary).
 * `packet-11c-request-classes.test.ts` regenerates the module text and requires byte equality with the committed file.
 */

const sha256 = (text: string) => sha256Hex(text);

/** The frozen model-facing contract identity, read from the code (the B5 freeze test pins each value and that its sources agree). */
export function requestClassContractInputsFromCode(): AiRequestClassContractInputs {
  return {
    slotPlan: SLOT_PLAN_VERSION,
    shellRequestProfile: SHELL_PROVIDER_REQUEST_VERSION,
    prompt: { version: PACKET_11_SHELL_PROMPT_VERSION, assetsSha256: sha256(JSON.stringify(SHELL_TASKS.flatMap((task) => AI_LOCALES.map((locale) => PACKET_11_SHELL_PROMPTS[task][locale])))) },
    providerSchema: {
      label: SHELL_PROVIDER_SCHEMA_VERSION,
      schemasSha256: sha256(JSON.stringify(SHELL_TASKS.flatMap((task) => AI_LOCALES.map((locale) => ({ name: shellOutputSchemaName(task, locale), schema: shellOutputJsonSchema(task, locale) }))))),
    },
    shellRules: SHELL_RULES_REVISION,
    validatorRules: VALIDATOR_RULES_REVISION,
    bundleKeys: { EXPLAIN_PATTERN: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey, DRAFT_CARE_PREPARATION_SUMMARY: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey },
    shellInputVersions: { ...SHELL_INPUT_VERSIONS },
    shellOutputVersions: { ...SHELL_OUTPUT_VERSIONS },
    temperature: SHELL_TEMPERATURE,
    maxOutputTokens: { ...SHELL_MAX_OUTPUT_TOKENS },
    // The route's provider and request model id (D2). The endpoint URL is server-only and pinned by the freeze test's shellRoute item;
    // it is not carried here, so the browser graph names no provider endpoint.
    routeModel: { providerKey: DEEPSEEK_RESPONSES_PROFILE.providerKey, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId },
  };
}

/** The contract digest: sha256 of the canonical JSON of the scheme and the inputs. */
export function requestClassContractDigest(inputs: AiRequestClassContractInputs): string {
  return sha256(canonicalizeJson({ scheme: AI_REQUEST_CLASS_SCHEME, inputs }));
}

/** The projected value-blind request of one FULL fixture, or null when its plan is not remote-eligible (it is never sent). */
export function projectedFixtureRequest(fixture: { request: Parameters<typeof planSlots>[0]; taskType: string }): ShellTaskRequest | null {
  const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
  if (planned.kind !== "PLANNED" || planned.plan.remote.eligible !== true) return null;
  return projectShellTaskRequest(planned.plan);
}

/** The class definitions generated from the 70 FULL fixtures, in first-fixture order; fixture ids in fixture order. */
export function generateRequestClassDefinitions(contractDigest: string): AiRequestClassDefinition[] {
  const classes = new Map<string, AiRequestClassDefinition & { sampleFixtureIds: string[] }>();
  for (const fixture of hybridFixturesForPhase("FULL")) {
    const request = projectedFixtureRequest(fixture);
    if (request === null) continue;
    const digest = shellRequestDigest(request);
    const classId = requestClassId(contractDigest, digest);
    const existing = classes.get(classId);
    if (existing) existing.sampleFixtureIds.push(fixture.id);
    else classes.set(classId, { classId, contractDigest, taskType: request.taskType, locale: request.locale, shellRequestDigest: digest, sampleFixtureIds: [fixture.id] });
  }
  return [...classes.values()];
}

/** The exact text of `src/application/ai/request-class-definitions.ts`. */
export function renderRequestClassDefinitionsModule(): string {
  const inputs = requestClassContractInputsFromCode();
  const contractDigest = requestClassContractDigest(inputs);
  const definitions = generateRequestClassDefinitions(contractDigest);
  const json = (value: unknown) => JSON.stringify(value);
  const lines = [
    `import type { AiLocale, ShellTask } from "@/domain/ai";`,
    ``,
    `/**`,
    ` * GENERATED FILE — do not edit by hand. Packet 11C Addendum C, Task C1 (owner approval of Addendum C, decision C1).`,
    ` * Generated by src/ai/evaluation/packet-11c-request-class-generator.ts; src/ai/evaluation/packet-11c-request-classes.test.ts`,
    ` * regenerates it and requires byte equality.`,
    ` *`,
    ` * The IMMUTABLE request-class definitions of the value-blind shell route, bound to the frozen model-facing contract:`,
    ` * - \`AI_REQUEST_CLASS_CONTRACT\`: the contract identity (\`inputs\`) and its digest, sha256 of the canonical JSON of`,
    ` *   { scheme, inputs }. Any change to a contract input changes the digest and so every classId (no unversioned structural hash).`,
    ` * - \`AI_REQUEST_CLASS_DEFINITIONS\`: one entry per distinct projected value-blind ShellTaskRequest of the 70 FULL fixtures.`,
    ` *   shellRequestDigest = sha256 of the request's canonical JSON; classId = sha256(contractDigest || shellRequestDigest) (the two`,
    ` *   64-hex digests concatenated). \`sampleFixtureIds\` are the FULL fixtures sharing that identical request and model-facing body:`,
    ` *   repeated samples of one body, never model exposure to any fixture's patient text (none crosses the boundary).`,
    ` * Plain data only: no evaluation, prompt, provider or credential code is imported (browser-safe). Whether a class may be sent is NOT`,
    ` * recorded here: that is the separate, owner-signed qualification record (request-class-qualification.ts; all PENDING).`,
    ` */`,
    `export const AI_REQUEST_CLASS_SCHEME = ${json(AI_REQUEST_CLASS_SCHEME)};`,
    ``,
    `export type AiRequestClassContractInputs = Readonly<{`,
    `  slotPlan: string;`,
    `  shellRequestProfile: string;`,
    `  prompt: Readonly<{ version: string; assetsSha256: string }>;`,
    `  providerSchema: Readonly<{ label: string; schemasSha256: string }>;`,
    `  shellRules: string;`,
    `  validatorRules: string;`,
    `  bundleKeys: Readonly<Record<ShellTask, string>>;`,
    `  shellInputVersions: Readonly<Record<ShellTask, string>>;`,
    `  shellOutputVersions: Readonly<Record<ShellTask, string>>;`,
    `  temperature: number;`,
    `  maxOutputTokens: Readonly<Record<ShellTask, number>>;`,
    `  routeModel: Readonly<{ providerKey: string; requestModelId: string }>;`,
    `}>;`,
    `export type AiRequestClassDefinition = Readonly<{ classId: string; contractDigest: string; taskType: ShellTask; locale: AiLocale; shellRequestDigest: string; sampleFixtureIds: readonly string[] }>;`,
    ``,
    `const CONTRACT_DIGEST = ${json(contractDigest)};`,
    ``,
    `export const AI_REQUEST_CLASS_CONTRACT: Readonly<{ scheme: typeof AI_REQUEST_CLASS_SCHEME; inputs: AiRequestClassContractInputs; digest: string }> = Object.freeze({`,
    `  scheme: AI_REQUEST_CLASS_SCHEME,`,
    `  inputs: Object.freeze({`,
    `    slotPlan: ${json(inputs.slotPlan)},`,
    `    shellRequestProfile: ${json(inputs.shellRequestProfile)},`,
    `    prompt: Object.freeze({ version: ${json(inputs.prompt.version)}, assetsSha256: ${json(inputs.prompt.assetsSha256)} }),`,
    `    providerSchema: Object.freeze({ label: ${json(inputs.providerSchema.label)}, schemasSha256: ${json(inputs.providerSchema.schemasSha256)} }),`,
    `    shellRules: ${json(inputs.shellRules)},`,
    `    validatorRules: ${json(inputs.validatorRules)},`,
    `    bundleKeys: Object.freeze({ EXPLAIN_PATTERN: ${json(inputs.bundleKeys.EXPLAIN_PATTERN)}, DRAFT_CARE_PREPARATION_SUMMARY: ${json(inputs.bundleKeys.DRAFT_CARE_PREPARATION_SUMMARY)} }),`,
    `    shellInputVersions: Object.freeze({ EXPLAIN_PATTERN: ${json(inputs.shellInputVersions.EXPLAIN_PATTERN)}, DRAFT_CARE_PREPARATION_SUMMARY: ${json(inputs.shellInputVersions.DRAFT_CARE_PREPARATION_SUMMARY)} }),`,
    `    shellOutputVersions: Object.freeze({ EXPLAIN_PATTERN: ${json(inputs.shellOutputVersions.EXPLAIN_PATTERN)}, DRAFT_CARE_PREPARATION_SUMMARY: ${json(inputs.shellOutputVersions.DRAFT_CARE_PREPARATION_SUMMARY)} }),`,
    `    temperature: ${json(inputs.temperature)},`,
    `    maxOutputTokens: Object.freeze({ EXPLAIN_PATTERN: ${json(inputs.maxOutputTokens.EXPLAIN_PATTERN)}, DRAFT_CARE_PREPARATION_SUMMARY: ${json(inputs.maxOutputTokens.DRAFT_CARE_PREPARATION_SUMMARY)} }),`,
    `    routeModel: Object.freeze({ providerKey: ${json(inputs.routeModel.providerKey)}, requestModelId: ${json(inputs.routeModel.requestModelId)} }),`,
    `  }),`,
    `  digest: CONTRACT_DIGEST,`,
    `});`,
    ``,
    `/** ${definitions.length} classes from the 70 FULL fixtures (generated order: first sample fixture). */`,
    `export const AI_REQUEST_CLASS_DEFINITIONS: readonly AiRequestClassDefinition[] = Object.freeze(`,
    `  [`,
    ...definitions.map(
      (definition) =>
        `    { classId: ${json(definition.classId)}, contractDigest: CONTRACT_DIGEST, taskType: ${json(definition.taskType)}, locale: ${json(definition.locale)}, shellRequestDigest: ${json(definition.shellRequestDigest)}, sampleFixtureIds: Object.freeze(${json(definition.sampleFixtureIds)}) },`,
    ),
    `  ].map((definition): AiRequestClassDefinition => Object.freeze(definition as AiRequestClassDefinition)),`,
    `);`,
    ``,
  ];
  return lines.join("\n");
}
