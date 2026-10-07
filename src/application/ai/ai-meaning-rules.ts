import type { AiTaskOutput, ProviderFact } from "@/domain/ai/ai-task-contracts";

/**
 * Packet 11A/11B forbidden-meaning rules (ai-system-spec Sections 0, 9,
 * 15.2; test-release 7.4), shared by the output validator and the
 * evaluation-only meaning diagnostic so both apply the identical rules. Every
 * rule is a frozen, non-global definition: no shared mutable regex state.
 * Internal to the AI application layer; nothing here is user-facing.
 */

export type MeaningRuleKind = "AUTHORITY" | "CLINICAL";
export type MeaningCategory =
  | "RISK"
  | "CAUSATION"
  | "CLINICAL_CLASSIFICATION"
  | "PREDICTION"
  | "DIAGNOSIS_OR_TRAJECTORY"
  | "MEDICATION_ACTION"
  | "DOSE_OR_MEDICINE_CHANGE"
  | "ADHERENCE_JUDGEMENT"
  | "TRIAGE_OR_EMERGENCY_INSTRUCTION"
  | "FALSE_REASSURANCE"
  | "CLINICAL_REVIEW_OR_RECIPIENT_CLAIM"
  | "APPLICATION_ACTION_CLAIM";
export type MeaningRule = Readonly<{ id: string; kind: MeaningRuleKind; category: MeaningCategory; locale: "en" | "zh"; pattern: RegExp }>;

const rule = (id: string, kind: MeaningRuleKind, category: MeaningCategory, locale: "en" | "zh", pattern: RegExp): MeaningRule => Object.freeze({ id, kind, category, locale, pattern: Object.freeze(pattern) });

/** Recipient-action or application-action claims the model can never make, then clinical meanings; validator order. */
export const MEANING_RULES: readonly MeaningRule[] = Object.freeze([
  rule("authority.recipient_review.en", "AUTHORITY", "CLINICAL_REVIEW_OR_RECIPIENT_CLAIM", "en", /\b(doctor|nurse|clinician|care team|pharmacist|clinic)s?\s+(has|have|had|will|did)\s+(already\s+)?(reviewed|seen|received|approved|checked|confirmed|read)\b/i),
  rule("authority.shared_with_recipient.en", "AUTHORITY", "CLINICAL_REVIEW_OR_RECIPIENT_CLAIM", "en", /\b(sent|shared|delivered|forwarded|submitted)\s+(this|it|the summary|your summary)?\s*to\s+(your\s+)?(doctor|clinic|care team|nurse|pharmacist)\b/i),
  rule("authority.application_action.en", "AUTHORITY", "APPLICATION_ACTION_CLAIM", "en", /\bi\s*(have|'ve)?\s+(updated|changed|saved|deleted|corrected|recorded|added|removed|booked)\s+(your|the|this)\b/i),
  rule("authority.recipient_review.zh", "AUTHORITY", "CLINICAL_REVIEW_OR_RECIPIENT_CLAIM", "zh", /医生.{0,4}(已经|已|会)?(看过|审阅|收到|确认|批准|检查过)/),
  rule("authority.shared_with_recipient.zh", "AUTHORITY", "CLINICAL_REVIEW_OR_RECIPIENT_CLAIM", "zh", /已(经)?(发送|分享|转发|提交)给/),
  rule("authority.application_action.zh", "AUTHORITY", "APPLICATION_ACTION_CLAIM", "zh", /我(已经|已)?(更新|修改|保存|删除|记录|添加|更正)了?/),
  rule("clinical.risk.en", "CLINICAL", "RISK", "en", /\b(at risk|risk of|risky|dangerous(ly)?|danger|unsafe|harmful|alarming|worrying)\b/i),
  rule("clinical.risk.zh", "CLINICAL", "RISK", "zh", /风险|危险|不安全|有害|严重/),
  rule("clinical.causation.en", "CLINICAL", "CAUSATION", "en", /\b(caus(e|ed|es|ing)|because of|due to|resulted? (from|in)|led to|leads to|triggered|thanks to|reason (for|why)|responsible for)\b/i),
  rule("clinical.causation.zh", "CLINICAL", "CAUSATION", "zh", /导致|原因|因为|由于|造成|引起|所以|归因/),
  rule("clinical.classification.en", "CLINICAL", "CLINICAL_CLASSIFICATION", "en", /\b(is|are|was|were|looks?|seems?|too|very|quite|bit|rather|dangerously)\s+(high|low)\b|\b(high|low)\s+side\b|\b(normal|abnormal|elevated|in range|out of range|within range|in target|on target|hypo|hyper|hypoglyc\w*|hyperglyc\w*|spik(e|es|ing))\b/i),
  rule("clinical.classification.zh", "CLINICAL", "CLINICAL_CLASSIFICATION", "zh", /偏高|偏低|过高|过低|太高|太低|正常|异常|超标|低血糖|高血糖|达标|在范围内/),
  rule("clinical.prediction.en", "CLINICAL", "PREDICTION", "en", /\b(will (keep|continue|rise|fall|go|be|get|become|increase|decrease|improve|worsen)|going to|likely to|expected to|predict\w*|forecast\w*|in (the )?future)\b/i),
  rule("clinical.prediction.zh", "CLINICAL", "PREDICTION", "zh", /会继续|将会|预计|预测|未来|会上升|会下降|会升高|会降低/),
  rule("clinical.diagnosis.en", "CLINICAL", "DIAGNOSIS_OR_TRAJECTORY", "en", /\b(diagnos\w*|worsening|getting worse|improving|deteriorat\w*|sign of|symptom of|suggests (that )?(you|your)|indicates (that )?(you|your)|show(s|ed|n|ing)? (that )?you('ve|'re| have| had| are| were))\b/i),
  rule("clinical.diagnosis.zh", "CLINICAL", "DIAGNOSIS_OR_TRAJECTORY", "zh", /诊断|恶化|好转|病情|表明您|说明您有|表明你|(?:显示|表明|说明)(?:出|了)?[您你](?:有|患|是|得)/),
  rule("clinical.medication_action.en", "CLINICAL", "MEDICATION_ACTION", "en", /\b(take (your|the|it|some|more|less|a)|skip (your|the|it|a)|stop taking|start taking|inject\w*|administer\w*|have your insulin)\b/i),
  rule("clinical.medication_action.zh", "CLINICAL", "MEDICATION_ACTION", "zh", /服用|服药|注射|打针|吃药|用药/),
  rule("clinical.dose_change.en", "CLINICAL", "DOSE_OR_MEDICINE_CHANGE", "en", /\b(increase|reduce|decrease|lower|raise|adjust|change|double|halve)\s+(the\s+|your\s+|a\s+)?(dose|dosage|insulin|units?)\b|\b(more|less|extra)\s+insulin\b/i),
  rule("clinical.dose_change.zh", "CLINICAL", "DOSE_OR_MEDICINE_CHANGE", "zh", /(增加|减少|调整|提高|降低|加大|减小)(剂量|胰岛素|用量)|剂量/),
  rule("clinical.adherence.en", "CLINICAL", "ADHERENCE_JUDGEMENT", "en", /\b(you missed|missed (a |your |the |this )?(dose|insulin|medicine|medication)|forgot (to take|your)|skipped (a |your |the |this )?(dose|insulin|medicine|medication)|non-?adherent|non-?compliant|adherence|compliance)\b/i),
  rule("clinical.adherence.zh", "CLINICAL", "ADHERENCE_JUDGEMENT", "zh", /漏服|漏打|忘记(服|吃|打)|没有按时|依从|遵医嘱/),
  rule("clinical.triage.en", "CLINICAL", "TRIAGE_OR_EMERGENCY_INSTRUCTION", "en", /\b(urgent\w*|emergency|immediately|right away|a&e|hospital|see a doctor|consult (a|your) doctor|seek (medical )?(help|care|attention)|call (995|911|999|an ambulance)|ambulance)\b|\b995\b/i),
  rule("clinical.triage.zh", "CLINICAL", "TRIAGE_OR_EMERGENCY_INSTRUCTION", "zh", /急诊|立刻|立即|马上|尽快就医|看医生|就医|救护车/),
  // false reassurance (Packet 11 bilingual review gate: "no implied … reassurance"): a status all-clear, …
  rule(
    "clinical.reassurance_status.en",
    "CLINICAL",
    "FALSE_REASSURANCE",
    "en",
    /\b(?:(?:is|are|was|were|be|look|looks|looked|seem|seems|seemed|appear|appears|appeared|sound|sounds|remain|remains|stay|stays)\s+(?:all\s+|perfectly\s+|completely\s+|totally\s+|entirely\s+|quite\s+|pretty\s+|very\s+|overall\s+)?(?:fine|ok|okay|alright|all right|safe|healthy|reassuring|under control|in order|in good health)(?!\s+to\b)|(?:you're|you are|they're|they are|it's|that's|everything's|all's)\s+(?:all\s+)?(?:fine|ok|okay|alright|good|safe|healthy|well)(?!\s+to\b)|all[- ](?:good|clear|fine|okay|ok)\b|rest assured|in (?:good|perfect) health|perfectly healthy|free (?:of|from) (?:any )?(?:problems?|issues?|disease|illness|concerns?)|nothing (?:is )?wrong|no (?:problems?|issues?|cause for concern|concerns?|worries|worry)\b)/i,
  ),
  rule("clinical.reassurance_status.zh", "CLINICAL", "FALSE_REASSURANCE", "zh", /(?:读数|结果|数值|情况|身体|您|你|它们|这些)[^。！？，,]{0,3}(?:都|全都|完全|非常|很|挺)(?:好|健康|安全|不错|理想)|一切\s*(?:都)?\s*(?:很|还|挺|非常)?\s*(?:好|正常|安全|顺利|没问题|fine|ok|okay|good|safe)|(?:都|全都|完全|非常|很|挺)(?:健康|安全)|(?:是|很)(?:健康|安全)的?|身体(?:很)?健康|没(?:有)?(?:什么|任何)?(?:问题|毛病)|没事|无碍|无大碍|安好|放心/i),
  // … or a statement that no worry, visit, follow-up or attention is needed.
  rule(
    "clinical.reassurance_no_action.en",
    "CLINICAL",
    "FALSE_REASSURANCE",
    "en",
    /\b(?:no need (?:for (?:you )?)?to (?:worry|be (?:worried|concerned)|see|visit|consult|call|contact|follow[- ]?up|check|seek|do anything|act)|no (?:further )?(?:action|follow[- ]?up|review|check[- ]?up|visit|appointment|consultation) (?:is |are )?(?:needed|required|necessary)|(?:don't|do not|need not|needn't|no reason to) (?:need to )?(?:worry|be worried|be concerned|see|visit|follow up)|nothing to (?:worry|be (?:worried|concerned)) about|(?:not|never) (?:necessary|needed) to (?:see|visit|consult|follow up|check|seek)|(?:can|may|could) (?:safely )?(?:ignore|disregard|skip)|safe to (?:ignore|skip|disregard|stop)|(?:confirms?|shows?|proves?|means?) (?:that )?(?:there (?:is|are) )?(?:no|nothing) (?:problems?|issues?|concerns?|cause for concern|wrong))/i,
  ),
  rule("clinical.reassurance_no_action.zh", "CLINICAL", "FALSE_REASSURANCE", "zh", /(?:不用|无需|不必|不需要|没必要|没有必要|用不着|别)(?:担心|紧张|看医生|复诊|就医|随访|跟进|检查|理会|处理|找医生)|没(?:有)?什么(?:好|需要|值得)?担心|(?:可以|能)(?:安全地)?(?:忽略|不理会|不用理会)|确认(?:没有|无|不存在)(?:问题|异常|风险|担忧)|(?:no need to|don't|do not)\s*(?:担心|紧张|看医生|复诊|就医)/i),
]);

/** A negated non-causal limitation ("does not explain the cause") is permitted wording, not a causal claim. */
const NEGATED_CAUSE_SOURCES = Object.freeze([
  Object.freeze({ source: String.raw`\b(does|do|did|can|could|cannot|can't|doesn't|don't)?\s*not\s+(explain|show|establish|prove|tell( you)?|mean)\s+(the\s+)?(cause|causes|why|reason)\b`, flags: "gi" }),
  Object.freeze({ source: String.raw`\b(cannot|can't|doesn't|don't)\s+(explain|show|establish|prove|tell( you)?)\s+(the\s+)?(cause|causes|why|reason)\b`, flags: "gi" }),
  Object.freeze({ source: String.raw`不(能)?(解释|说明|代表|表示|证明)[^。！？]*?原因`, flags: "g" }),
]);

/**
 * Whole-sentence templates for wording the ordinary journal is required or
 * permitted to say (Packet 11B corrective pass). A sentence is excluded from
 * clinical scanning only when it matches one template from start to end, built
 * from closed vocabulary: a fixed subject, a negated epistemic verb and a
 * causal object for the required DOES_NOT_ESTABLISH_CAUSE limitation, or a
 * fixed "based on selected records" process statement. Any extra clause,
 * subject, object or punctuation-joined claim falls back to normal scanning,
 * so negation alone never makes wording acceptable.
 */
const EN_SUBJECT = String.raw`(?:this|it|this (?:comparison|information|record|explanation|summary|data|pattern)|these (?:records|readings|results|values|comparisons)|the (?:records|readings|comparison|data|information))`;
const EN_NEGATION = String.raw`(?:does not|do not|did not|doesn't|don't|cannot|can't|can not|could not|is not able to|are not able to)`;
const EN_EPISTEMIC_VERB = String.raw`(?:establish|show|explain|prove|determine|identify|confirm|tell us|tell you)`;
const EN_CHANGE = String.raw`(?:difference|change|variation)`;
const EN_CAUSAL_OBJECT = String.raw`(?:(?:a|the|any) (?:cause|reason)(?: (?:of|for) (?:the|this|that) (?:${EN_CHANGE}|readings?|values?))?|what caused (?:the|this|that) ${EN_CHANGE}|why (?:the|these) (?:readings|values) (?:differed|changed|varied|were different)|cause and effect)`;
const ZH_SUBJECT = "(?:这|此|这些记录|这些读数|这些数据|这个比较|这项比较|此比较)?";
const ZH_NEGATED_VERB = "(?:不能|无法|并不能|并不|不|未能)(?:确定|说明|证明|解释|表明|显示|判断)";
const ZH_CAUSAL_OBJECT = "(?:(?:读数|数值)?(?:差异|变化|不同)?的?原因|是什么导致了(?:差异|变化|这种差异|这一变化|读数的差异)|因果关系)";

/** Truthful reassurance limitations (Packet 11B): whole-sentence, closed vocabulary only. */
const EN_SCOPE_SUBJECT = String.raw`(?:this|it|these|the)(?: (?:information|explanation|summary|comparison|records?|readings|data))?`;
const ZH_SCOPE_SUBJECT = "(?:这|这些资料|这些记录|这些信息|此信息|这份说明|这份摘要)?";

const PERMITTED_SENTENCES: readonly RegExp[] = Object.freeze(
  [
    new RegExp(String.raw`^${EN_SCOPE_SUBJECT} (?:cannot|can't|can not|does not|do not|is not able to) (?:determine|show|tell (?:you|us)|confirm|establish) (?:whether|if) (?:everything|your readings|the readings|your health|it|this|they) (?:is|are) (?:normal|fine|okay|ok|safe|healthy)$`),
    new RegExp(String.raw`^no conclusion (?:about|on|regarding) (?:your )?(?:safety|health|safety or health|health or safety) can be (?:made|drawn)$`),
    new RegExp(String.raw`^(?:this|the) (?:explanation|summary|information) is not (?:reassurance|a reassurance|an all-clear|an all clear|medical advice)$`),
    new RegExp(String.raw`^(?:the )?recorded (?:information|readings|records) should be reviewed rather than (?:treated|taken|read) as an all[- ]clear$`),
    new RegExp(`^${ZH_SCOPE_SUBJECT}(?:无法|不能|并不能)(?:判断|确定|说明|证明|显示)(?:一切|读数|结果|情况|您的健康)?是否(?:正常|安全|健康|没有问题|良好)$`),
    new RegExp("^(?:已)?记录的(?:资料|信息|读数)应(?:该)?(?:被)?(?:查看|检查|审阅)，?而不是(?:被)?(?:当作|视为|看作)(?:一切正常|没有问题)$"),
    new RegExp(String.raw`^${EN_SUBJECT} ${EN_NEGATION} ${EN_EPISTEMIC_VERB} ${EN_CAUSAL_OBJECT}$`),
    new RegExp(String.raw`^(?:the|a) (?:cause|reason) (?:of|for) (?:the|this|that) ${EN_CHANGE} (?:is|was) not (?:established|known|shown|explained|identified|determined)(?: by (?:this|these) (?:comparison|records|readings))?$`),
    new RegExp(String.raw`^(?:this|the) (?:summary|explanation|comparison|overview) (?:will be|is) based (?:only )?on (?:the |your )?(?:\d{1,3} )?(?:(?:selected|supplied|chosen|recorded) )*(?:information|records?|readings?|entries|facts)$`),
    new RegExp(`^${ZH_SUBJECT}${ZH_NEGATED_VERB}${ZH_CAUSAL_OBJECT}$`),
  ].map((pattern) => Object.freeze(pattern)),
);

/** Splits after sentence punctuation (not after a decimal point) and drops whole permitted sentences. */
function withoutPermittedSentences(text: string): string {
  return text
    .split(/(?<=[!?。！？]|\.(?!\d))/)
    .map((sentence) => {
      const normalised = sentence.replace(/[.!?。！？]+\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
      return normalised.length > 0 && PERMITTED_SENTENCES.some((pattern) => pattern.test(normalised)) ? " " : sentence;
    })
    .join("");
}

/** The text the clinical rules are applied to; global regexes are created per call, never shared. */
export function meaningScanText(text: string): string {
  return NEGATED_CAUSE_SOURCES.reduce((current, entry) => current.replace(new RegExp(entry.source, entry.flags), " "), withoutPermittedSentences(text));
}

/** Removes verbatim patient-authored supplied text: quotation is not endorsement, and it is checked at its source. */
export function withoutQuotations(text: string, facts: readonly ProviderFact[]): string {
  let remaining = text;
  for (const fact of facts) if (fact.value.kind === "TEXT") remaining = remaining.split(fact.value.text).join(" ");
  return remaining;
}

/** Every generated text field of a SUCCESS output, in validator order, with its schema-defined path. */
export function generatedTextFields(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>): Array<{ path: string; text: string }> {
  switch (output.taskType) {
    case "EXTRACT_CANDIDATE_FACTS":
      return [];
    case "EXPLAIN_PATTERN":
      return [
        { path: "payload.headline.text", text: output.payload.headline.text },
        { path: "payload.observation.text", text: output.payload.observation.text },
        { path: "payload.evidence.text", text: output.payload.evidence.text },
      ];
    case "DRAFT_NEUTRAL_INQUIRY":
      return [
        ...(output.payload.observation ? [{ path: "payload.observation.text", text: output.payload.observation.text }] : []),
        { path: "payload.question.text", text: output.payload.question.text },
        ...output.payload.optionLabels.map((entry) => ({ path: "payload.optionLabels[].label", text: entry.label })),
      ];
    case "ANSWER_BOUNDED_RECORD_QUERY":
      return output.payload.segments.map((entry) => ({ path: "payload.segments[].text", text: entry.text }));
    case "DRAFT_CARE_PREPARATION_SUMMARY":
      return output.payload.sections.flatMap((section) => section.bullets.map((bullet) => ({ path: "payload.sections[].bullets[].text", text: bullet.text })));
    case "PHRASE_NON_CLINICAL_RESPONSE":
      return [{ path: "payload.message.text", text: output.payload.message.text }];
  }
}

/** Rules matched by one generated field after quotation removal: authority on the text, clinical on the scan text. */
export function meaningMatches(text: string): MeaningRule[] {
  const scanned = meaningScanText(text);
  return MEANING_RULES.filter((entry) => entry.pattern.test(entry.kind === "AUTHORITY" ? text : scanned));
}
