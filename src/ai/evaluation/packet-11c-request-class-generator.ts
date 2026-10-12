import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider, DEEPSEEK_RESPONSES_PROFILE } from "@/ai/deepseek/deepseek-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { SHELL_PROVIDER_SCHEMA_VERSION, shellOutputJsonSchema, shellOutputSchemaName } from "@/ai/kie/kie-shell-contracts";
import { PACKET_11_SHELL_PROMPT_VERSION, PACKET_11_SHELL_PROMPTS } from "@/ai/prompts/packet-11-shell-prompts";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { SHELL_RULES_REVISION } from "@/application/ai/language/shell-lexicon";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_REQUEST_CLASS_SCHEME, type AiRequestClassContractInputs, type AiRequestClassDefinition } from "@/application/ai/request-class-definitions";
import { aiRequestClassQualificationRecordSchema, requestClassId, shellRequestDigest, type AiRequestClassQualificationRecord } from "@/application/ai/request-class-qualification";
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
 *
 * Packet 11C Addendum C, CL3 contract re-freeze (Task RF, C1-review carry): the contract inputs also bind the exact model-facing bytes and
 * the provider endpoint: `modelFacingBodySha256` is the sha256 of each class's captured model-facing body (the real DeepSeek shell adapter
 * with a fetcher that records the body and throws, exactly as the presentation guard captures it; every sample of a class must yield the
 * same body), keyed by the class's shellRequestDigest, and `endpointSha256` is the sha256 of the URL that adapter sends to (the URL itself
 * stays server-only). This changed every classId (intended). The SHIPPED qualification records are generated here too
 * (`renderQualificationRecordsBlock`): one per definition, PENDING with no evidence and no sign-off unless an owner sign-off record for
 * that class is passed in (this generator never decides a status); the test requires the records literal in
 * `request-class-qualification.ts` to be byte-identical to it.
 *
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12): the owner's sign-off records for the six en-SG classes are pinned
 * in packet-11c-request-classes.test.ts and passed in there; the six zh-SG classes render PENDING.
 */

const sha256 = (text: string) => sha256Hex(text);

/** A fixed selection clock (the presentation guard's): the documented deepseek-flash entry does not depend on it. */
const CAPTURE_NOW = () => "2026-10-08T00:00:00.000Z";
const CAPTURE_SENTINEL = "ds-SENTINEL-CREDENTIAL-request-class-generator";

/**
 * The exact model-facing request of one projected value-blind request: the real DeepSeek shell adapter (the route's provider, D2) with a
 * fetcher that records the URL and body and throws. No provider call is made.
 */
export async function captureModelFacingRequest(request: ShellTaskRequest): Promise<{ url: string; body: string }> {
  const selection = selectEvaluationCandidates({ requested: APPROVED_HYBRID_CONTRACT.requestModelId, listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: CAPTURE_NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("REQUEST_CLASS_CAPTURE_MODEL_NOT_SELECTABLE");
  const sent: Array<{ url: string; body: string }> = [];
  const provider = createDeepSeekShellResponsesProvider({
    token: CAPTURE_SENTINEL,
    model: selection.candidates[0]!,
    fetcher: async (url, init) => {
      sent.push({ url: String(url), body: String(init.body) });
      throw new Error("OFFLINE_CAPTURE_ONLY");
    },
  });
  await provider.invoke(request, new AbortController().signal);
  if (sent.length !== 1) throw new Error("REQUEST_CLASS_CAPTURE_NOT_ONE_BODY");
  return sent[0]!;
}

/**
 * The captured model-facing body sha256 of every class (keyed by shellRequestDigest, in first-fixture order) and the sha256 of the one
 * endpoint every capture went to. Fails when two samples of one class yield different bodies or a capture goes elsewhere.
 */
export async function capturedClassBodies(): Promise<{ modelFacingBodySha256: Record<string, string>; endpointSha256: string }> {
  const bodies: Record<string, string> = {};
  for (const fixture of hybridFixturesForPhase("FULL")) {
    const request = projectedFixtureRequest(fixture);
    if (request === null) continue;
    const { url, body } = await captureModelFacingRequest(request);
    if (url !== DEEPSEEK_RESPONSES_URL) throw new Error(`REQUEST_CLASS_CAPTURE_ENDPOINT_UNEXPECTED: ${fixture.id}`);
    const key = shellRequestDigest(request);
    const bodySha = sha256(body);
    if (bodies[key] !== undefined && bodies[key] !== bodySha) throw new Error(`REQUEST_CLASS_BODY_NOT_UNIQUE: ${fixture.id}`);
    bodies[key] = bodySha;
  }
  return { modelFacingBodySha256: bodies, endpointSha256: sha256(DEEPSEEK_RESPONSES_URL) };
}

/** The frozen model-facing contract identity, read from the code (the B5 freeze test pins each value and that its sources agree). */
export async function requestClassContractInputsFromCode(): Promise<AiRequestClassContractInputs> {
  const { modelFacingBodySha256, endpointSha256 } = await capturedClassBodies();
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
    // only its sha256 is carried here (below), so the browser graph names no provider endpoint.
    routeModel: { providerKey: DEEPSEEK_RESPONSES_PROFILE.providerKey, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId },
    // CL3 re-freeze (C1-review carry): the exact model-facing bytes of every class and the endpoint they go to.
    modelFacingBodySha256,
    endpointSha256,
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
export async function renderRequestClassDefinitionsModule(): Promise<string> {
  const inputs = await requestClassContractInputsFromCode();
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
    ` *   CL3 re-freeze (C1-review carry): the inputs also carry the sha256 of each class's captured model-facing body (keyed by its`,
    ` *   shellRequestDigest) and the sha256 of the provider endpoint URL (the URL itself stays server-only).`,
    ` * - \`AI_REQUEST_CLASS_DEFINITIONS\`: one entry per distinct projected value-blind ShellTaskRequest of the 70 FULL fixtures.`,
    ` *   shellRequestDigest = sha256 of the request's canonical JSON; classId = sha256(contractDigest || shellRequestDigest) (the two`,
    ` *   64-hex digests concatenated). \`sampleFixtureIds\` are the FULL fixtures sharing that identical request and model-facing body:`,
    ` *   repeated samples of one body, never model exposure to any fixture's patient text (none crosses the boundary).`,
    ` * Plain data only: no evaluation, prompt, provider or credential code is imported (browser-safe). Whether a class may be sent is NOT`,
    ` * recorded here: that is the separate, owner-signed qualification record (request-class-qualification.ts).`,
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
    `  modelFacingBodySha256: Readonly<Record<string, string>>;`,
    `  endpointSha256: string;`,
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
    `    modelFacingBodySha256: Object.freeze({`,
    ...Object.entries(inputs.modelFacingBodySha256).map(([requestDigest, bodySha]) => `      ${json(requestDigest)}: ${json(bodySha)},`),
    `    }),`,
    `    endpointSha256: ${json(inputs.endpointSha256)},`,
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

/** The first line of the shipped records literal in `request-class-qualification.ts`, and the first line after it. */
export const QUALIFICATION_RECORDS_START = "export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS";
export const QUALIFICATION_RECORDS_END = "\n\nexport const SHIPPED_REQUEST_CLASS_REGISTRY";

/**
 * CL3 re-freeze: the exact text of the shipped records literal (from `export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS` to its closing
 * `);`): one record per definition, in definition order, PENDING with no evidence and no sign-off. Moving a class to QUALIFIED is an
 * owner sign-off, never this generator: Packet 11C English activation (owner decisions Q and A, 2026-10-12) passes the owner's sign-off
 * records in `ownerSignOffs`, each rendered as given. Each must be schema-valid, name a definition's class under that definition's
 * contract, and appear at most once; anything else throws (nothing is rendered QUALIFIED by default).
 */
export function renderQualificationRecordsBlock(
  definitions: readonly Pick<AiRequestClassDefinition, "classId" | "contractDigest">[],
  ownerSignOffs: readonly AiRequestClassQualificationRecord[] = [],
): string {
  const json = (value: unknown) => JSON.stringify(value);
  const signOffOf = new Map<string, AiRequestClassQualificationRecord>();
  for (const signOff of ownerSignOffs) {
    const record = aiRequestClassQualificationRecordSchema.parse(signOff);
    const definition = definitions.find((entry) => entry.classId === record.classId);
    if (definition === undefined || definition.contractDigest !== record.contractDigest || signOffOf.has(record.classId)) throw new Error(`QUALIFICATION_SIGN_OFF_INVALID: ${record.classId}`);
    signOffOf.set(record.classId, record);
  }
  const line = (definition: Pick<AiRequestClassDefinition, "classId" | "contractDigest">) => {
    const signOff = signOffOf.get(definition.classId);
    return signOff === undefined
      ? `    { classId: ${json(definition.classId)}, contractDigest: ${json(definition.contractDigest)}, status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },`
      : `    { classId: ${json(signOff.classId)}, contractDigest: ${json(signOff.contractDigest)}, status: ${json(signOff.status)}, evidenceRef: ${json(signOff.evidenceRef)}, signedOffBy: ${json(signOff.signedOffBy)}, signedOffAt: ${json(signOff.signedOffAt)} },`;
  };
  return [
    `${QUALIFICATION_RECORDS_START}: readonly AiRequestClassQualificationRecord[] = Object.freeze(`,
    `  ([`,
    ...definitions.map(line),
    `  ] as const satisfies readonly AiRequestClassQualificationRecord[]).map((record): AiRequestClassQualificationRecord => Object.freeze({ ...record })),`,
    `);`,
  ].join("\n");
}

/**
 * Splits the qualification module source at its shipped records literal (exactly one, ending before SHIPPED_REQUEST_CLASS_REGISTRY):
 * `records` is the literal, `outside` the rest of the module with the literal replaced by a fixed marker. The freeze pins sha256(outside),
 * so the qualification rule, schema and gate are frozen independently of the regenerated records.
 */
export function splitQualificationModule(source: string): { records: string; outside: string } {
  const start = source.indexOf(QUALIFICATION_RECORDS_START);
  const end = source.indexOf(QUALIFICATION_RECORDS_END);
  if (start < 0 || end < start || source.indexOf(QUALIFICATION_RECORDS_START, start + 1) >= 0 || source.indexOf(QUALIFICATION_RECORDS_END, end + 1) >= 0) {
    throw new Error("QUALIFICATION_RECORDS_LITERAL_NOT_FOUND");
  }
  return { records: source.slice(start, end), outside: `${source.slice(0, start)}<SHIPPED_RECORDS_LITERAL>${source.slice(end)}` };
}
