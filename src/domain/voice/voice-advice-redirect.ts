import { VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY, voiceRedirectMessageKey, type VoiceLanguage, type VoiceRedirectCategory } from "./voice-contracts";
import { voiceVocabulary } from "./voice-vocabulary";

/**
 * Packet 13 (P13S; 13s.3 safety fixes and owner decisions #3/#4): the neutral redirect classifier. Pure and local; it sends nothing.
 *
 * DOSE_TREATMENT (copy `voice.redirect.body`) when:
 *   A. a dose or treatment term occurs with a question cue OR a medicine noun (no "?" needed: "insulin, how many units now",
 *      "胰岛素打多少", "I want to stop my medicine"), EXCEPT a REPORTED amount (owner #4): the only dose terms are a bare unit
 *      ("units"), the person states an occurrence (took / injected / didn't take ...) and there is no question form anywhere
 *      ("I injected 10 units of my grey pen" is factual reporting, kept for review with its amount); or
 *   B. a treatment question: a strict question form with a medicine noun (EN also: a treatment verb such as take/inject/stop/skip):
 *      "Should I take my insulin", "胰岛素要打吗".
 * HEALTH_QUESTION (copy `voice.redirect.healthBody`: "JagaOn can record what you report, but cannot assess whether a reading is
 * dangerous or recommend treatment. Please check with your care team.") when, and it is not a dose question:
 *   C. a glucose cue with a health question form ("Sugar 3 mmol, what should I eat", "is that dangerous", "我该怎么办"); or
 *   D. explicit health-assessment content ("dangerous", "hospital", "emergency", "help", "怎么办", "医院"); or
 *   E. any question form with a health topic ("Can I exercise today?", "What can I eat for dinner?", "我可以吃西瓜吗").
 * The app then shows the fixed bilingual copy of that category and the note that the voice was transcribed by Tencent Cloud but the
 * question went nowhere else. Over-redirect is the safe direction (pinned in tests); a clearly separable factual reading beside the
 * question stays reviewable (analyseTranscript), and the remote-extraction gate withholds the whole transcript.
 */
export type VoiceRedirectDecision =
  | Readonly<{ kind: "REDIRECT"; category: VoiceRedirectCategory; messageKey: ReturnType<typeof voiceRedirectMessageKey>; transcribedNoteKey: typeof VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY }>
  | Readonly<{ kind: "NONE" }>;

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sortLongestFirst = (words: readonly string[]) => [...words].sort((left, right) => right.length - left.length);

/** English: whole words (flexible spaces and apostrophes); symbols anywhere. Chinese: plain substrings. */
export function voiceWordMatcher(words: readonly string[], language: VoiceLanguage, flags = "i"): RegExp {
  if (words.length === 0) return /(?!)/;
  if (language === "zh") return new RegExp(sortLongestFirst(words).map(escape).join("|"), flags.replace("i", ""));
  const wordy = sortLongestFirst(words.filter((word) => /[a-z]/i.test(word))).map((word) => escape(word).replace(/ /g, "\\s+").replace(/'/g, "['’]?"));
  const symbols = words.filter((word) => !/[a-z]/i.test(word)).map(escape);
  return new RegExp([...(wordy.length > 0 ? [`(?<![A-Za-z])(?:${wordy.join("|")})(?![A-Za-z])`] : []), ...symbols].join("|"), flags);
}

function matchers(language: VoiceLanguage) {
  const vocabulary = voiceVocabulary(language);
  return Object.freeze({
    term: voiceWordMatcher(vocabulary.doseTreatmentTerms, language),
    termAll: voiceWordMatcher(vocabulary.doseTreatmentTerms, language, language === "zh" ? "g" : "gi"),
    reportedTerm: voiceWordMatcher(vocabulary.reportedAmountTerms, language),
    occurrence: voiceWordMatcher([...vocabulary.statusTaken, ...vocabulary.statusSkipped], language),
    question: voiceWordMatcher(vocabulary.questionCues, language),
    form: voiceWordMatcher(vocabulary.treatmentQuestionForms, language),
    noun: voiceWordMatcher(vocabulary.medicineNouns, language),
    verb: voiceWordMatcher(vocabulary.treatmentVerbs, language),
    glucose: voiceWordMatcher(vocabulary.glucoseCues, language),
    health: voiceWordMatcher(vocabulary.healthQuestionForms, language),
    healthTopic: voiceWordMatcher(vocabulary.healthTopics, language),
    healthExplicit: voiceWordMatcher(vocabulary.healthExplicit, language),
    anyQuestion: voiceWordMatcher(vocabulary.questionForms, language),
    healthAsk: voiceWordMatcher(vocabulary.healthAskForms, language),
  });
}
const MATCHERS = Object.freeze({ en: matchers("en"), zh: matchers("zh") });
/**
 * Round 4 (I1): an English question without "?": a clause-initial auxiliary before a possessive or article ("Is my sugar 7.2",
 * "Was my sugar 7.2", "Could my sugar be 7.2").
 */
const EN_AUX_QUESTION = /(?:^|[.!?;,，。！？；]\s*)(?:is|was|are|were|has|have|did|does|do|can|could|will|would)\s+(?:my|the|your|our|his|her|their|it|this|that)(?![A-Za-z])/i;
/** Any question form; Chinese also the A-not-A form (疼不疼, 打不打); English also a clause-initial auxiliary question. */
const isQuestion = (text: string, language: VoiceLanguage) =>
  MATCHERS[language].anyQuestion.test(text) || (language === "zh" ? /(\p{Script=Han})不\1/u.test(text) : EN_AUX_QUESTION.test(text.trim()));
/**
 * Round 4 (minor): broad words that are a dose/treatment request only inside a question ("Do I need to go up?", 要不要停, 我能停吗),
 * never in a statement beside a medicine ("my sugar did not go up", 停车费, 咖啡加了糖). The remote-extraction gate still withholds them.
 */
const WEAK_DOSE_TERMS: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /(?<![A-Za-z])(?:go\s+up|go\s+down)(?![A-Za-z])/i,
  zh: /加|停/,
});
/** Round 4 (minor): "how much should I eat" is a food (health) question in both languages, never a dose question. */
const EAT_AMOUNT: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /(?<![A-Za-z])how\s+(?:much|many)(?![A-Za-z])[^.?!？]*(?<![A-Za-z])(?:eat|have|drink)(?![A-Za-z])/i,
  zh: /(?:吃|喝)[^，。？?！!]{0,3}(?:多少|几)|(?:多少|几)[^，。？?！!]{0,2}(?:饭|东西|水果)/,
});
const EAT_AMOUNT_TERMS: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({ en: /^how\s+(?:much|many)$/i, zh: /^(?:多少|几)$/ });

const decision = (category: VoiceRedirectCategory): VoiceRedirectDecision =>
  Object.freeze({ kind: "REDIRECT", category, messageKey: voiceRedirectMessageKey(category), transcribedNoteKey: VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY });
const DOSE = decision("DOSE_TREATMENT");
const HEALTH = decision("HEALTH_QUESTION");
const NONE: VoiceRedirectDecision = Object.freeze({ kind: "NONE" });

/** Owner #4: every dose term in the text is a bare unit, an occurrence is stated, and nothing is asked. */
function reportedAmountOnly(text: string, language: VoiceLanguage): boolean {
  const m = MATCHERS[language];
  const terms = [...text.matchAll(m.termAll)].map((match) => match[0]);
  return terms.length > 0 && terms.every((term) => m.reportedTerm.test(term)) && m.occurrence.test(text) && !isQuestion(text, language);
}

export function classifyVoiceAdviceRedirect(transcript: string, language: VoiceLanguage): VoiceRedirectDecision {
  const m = language === "zh" ? MATCHERS.zh : MATCHERS.en;
  const text = typeof transcript === "string" ? transcript : "";
  const noun = m.noun.test(text);
  const eatAmountOnly = EAT_AMOUNT[language].test(text) && !noun && [...text.matchAll(m.termAll)].every((match) => EAT_AMOUNT_TERMS[language].test(match[0]));
  if (!eatAmountOnly && m.term.test(text) && (m.question.test(text) || noun) && !reportedAmountOnly(text, language)) return DOSE;
  if (WEAK_DOSE_TERMS[language].test(text) && isQuestion(text, language)) return DOSE;
  if (!eatAmountOnly && m.form.test(text) && (language === "zh" ? noun && m.verb.test(text) : noun || m.verb.test(text))) return DOSE;
  // P13X review CRITICAL 2: indirect questions ("I wonder whether to inject more", "need to see doctor or not", 想知道要不要 …).
  // The redirect uses a narrower "or not" (only after a care or treatment verb), so "my sugar was 6.8 or not" stays a reading.
  const indirect = language === "en" ? EN_INDIRECT_REDIRECT.test(text) : GATE_ZH_INDIRECT_QUESTION.test(text);
  if (indirect && (noun || m.verb.test(text) || m.term.test(text))) return DOSE;
  if (indirect && m.healthTopic.test(text)) return HEALTH;
  if (language === "zh" && ZH_DOSE_QUESTION.test(text)) return DOSE;
  if (language === "en" && (EN_SINGLISH_QUESTION_TAG.test(text) || EN_SINGLISH_CAN_QUESTION.test(text))) {
    if (noun || m.verb.test(text) || m.term.test(text)) return DOSE;
    if (EN_SINGLISH_CAN_QUESTION.test(text) || EN_ASSESSMENT_WORD.test(text) || m.healthTopic.test(text.replace(new RegExp(m.glucose.source, "gi"), " "))) return HEALTH;
  }
  // Recheck 6 (CRITICAL B): an explicit Chinese "I want to ask" beside a reading or health topic in either language.
  if (language === "zh" && ZH_EXPLICIT_ASK.test(text) && (m.glucose.test(text) || MATCHERS.en.glucose.test(text) || MATCHERS.en.healthTopic.test(text))) return HEALTH;
  if (m.glucose.test(text) && m.health.test(text)) return HEALTH;
  if (m.healthExplicit.test(text)) return HEALTH;
  if ((m.healthAsk.test(text) || (language === "zh" && /(\p{Script=Han})不\1/u.test(text))) && m.healthTopic.test(text)) return HEALTH;
  return NONE;
}

/** Cr4: any question form at all (the remote-extraction gate withholds every transcript with one). */
/**
 * Round 5 (Critical 2, GATE ONLY; the redirect classification is unchanged): any clause-initial auxiliary followed by any word is a
 * question for the remote gate ("Is sugar 7.2 high", "Was I supposed to …", "Am I taking …"). Over-withholding is the safe direction.
 */
const GATE_EN_AUX_QUESTION = /(?:^|[.!?;,，。！？；]\s*)(?:is|was|are|were|am|has|have|did|does|do|can|could|will|would|should)\s+[A-Za-z]/i;

export function hasVoiceQuestionForm(transcript: string, language: VoiceLanguage): boolean {
  const text = typeof transcript === "string" ? transcript : "";
  const lang = language === "zh" ? "zh" : "en";
  return isQuestion(text, lang) || (lang === "en" ? GATE_EN_AUX_QUESTION.test(text.trim()) || GATE_EN_INDIRECT_QUESTION.test(text) : GATE_ZH_INDIRECT_QUESTION.test(text));
}
/**
 * P13X review CRITICAL 2 (GATE ONLY): indirect questions without "?": "I wonder whether to inject more", "need to see doctor or not",
 * "not sure if I should …"; ZH 还是不, 要还是不要, 想知道.
 */
const GATE_EN_INDIRECT_QUESTION =
  /(?<![A-Za-z])(?:whether|wonder|wondering|wondered|or\s+not|anot|not\s+sure\s+(?:if|whether)|want\s+to\s+know|ask(?:ing)?\s+(?:if|whether))(?![A-Za-z])/i;
/** Recheck 6 (CRITICAL B): also 想问 / 请问 / 问一下 ("我想问 sugar 15 normal anot"); used by the gate AND the redirect. */
const GATE_ZH_INDIRECT_QUESTION = /还是不|还是要|想知道|不知道该|不知道要|想问|请问|问一下/;
/**
 * Recheck 6 (CRITICAL B): the Singlish question tags "anot", "can or not", "or not ah/leh/lah/ar/huh" ("sugar 15 normal anot"). In the
 * redirect they count with a health topic other than the bare glucose cue (so "sugar 6.8 anot" alone stays a reading for review; the
 * gate withholds it), or with a medicine noun, treatment verb or dose term.
 */
const EN_SINGLISH_QUESTION_TAG = /(?<![A-Za-z])(?:anot|can\s+(?:or\s+not|anot)|or\s+not\s+(?:ah|ar|leh|lah|huh|hor))(?![A-Za-z])/i;
const EN_ASSESSMENT_WORD = /(?<![A-Za-z])(?:ok|okay|high|low|good|fine|safe|normal|too\s+high|too\s+low)(?![A-Za-z])/i;
const ZH_EXPLICIT_ASK = /想问|请问|问一下/;
/** "can … or not" / "can … anot" asks permission ("sugar 15 can makan durian or not"): a health question. */
const EN_SINGLISH_CAN_QUESTION = /(?<![A-Za-z])can(?![A-Za-z])[^.,;!?，。]{0,40}(?<![A-Za-z])(?:or\s+not|anot)(?![A-Za-z])/i;
/**
 * Recheck 6 (must-fix, owner requirement 6): Chinese dose questions that need no question cue or medicine noun, so code-switched text
 * under either locale is redirected ("Sugar 15 我要不要打多一点", "Sugar 15, 打多少 units ah"). 要不要吃 alone is a food question
 * (a health topic), not here.
 */
const ZH_DOSE_QUESTION = /要不要打|该不该打|应不应该打|打多少|打几|打多一点|打多点|打少一点|打少点|多打一点|少打一点|吃几片|吃几粒|吃多少片|吃多少粒/;
const EN_INDIRECT_REDIRECT =
  /(?<![A-Za-z])(?:whether|wonder|wondering|wondered|not\s+sure\s+(?:if|whether)|ask(?:ing)?\s+(?:if|whether))(?![A-Za-z])|(?<![A-Za-z])(?:see|go|visit|call|take|inject|use|stop|skip|eat|have|increase|reduce|double)(?![A-Za-z])[^.,;!?，。]{0,40}(?<![A-Za-z])or\s+not(?![A-Za-z])/i;

const AMOUNT = Object.freeze({
  en: new RegExp(`(?<![A-Za-z0-9.])(?:\\d+(?:\\.\\d+)?|${voiceVocabulary("en").integerWords.join("|")})\\s*(?:${voiceVocabulary("en").amountUnits.join("|")})(?![A-Za-z])`, "i"),
  zh: new RegExp(`(?:[0-9０-９]+|[零〇一二两三四五六七八九十百]+)\\s*(?:${voiceVocabulary("zh").amountUnits.join("|")})`),
});

/** Cr4: any dose or treatment term at all, or any spoken amount (number + unit, e.g. "10 units", 十个单位, 两片): the gate is stricter. */
export function hasVoiceDoseTerm(transcript: string, language: VoiceLanguage): boolean {
  const text = typeof transcript === "string" ? transcript : "";
  const lang = language === "zh" ? "zh" : "en";
  return (
    MATCHERS[lang].term.test(text) ||
    WEAK_DOSE_TERMS[lang].test(text) ||
    AMOUNT[lang].test(text) ||
    GATE_SPOKEN_COUNT[lang].test(text) ||
    (lang === "zh" && ZH_DOSE_QUESTION.test(text)) ||
    GATE_TREATMENT_CHANGE[lang].test(text) ||
    gateAdvisedTreatment(text, lang)
  );
}

/**
 * Recheck 6 (optional, GATE ONLY): a spoken count without an amount unit ("half a tablet", "half my pill", "two white ones", 半片,
 * 两个白色的) withholds the whole transcript. A count before a medicine NAME ("2 metformin") is not matched here: the gate has no
 * medicine directory, and a bare "number + word" rule would withhold ordinary readings ("sugar 15 today").
 */
const GATE_SPOKEN_COUNT: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: new RegExp(
    [
      "(?<![A-Za-z])half\\s+(?:a|an|of|my|the)\\s+(?!(?:an\\s+)?(?:hour|day|bowl|plate|cup|glass|portion|serving|slice|piece|apple|banana|orange)s?(?![A-Za-z]))",
      `(?<![A-Za-z0-9.])(?:\\d+|${voiceVocabulary("en").integerWords.join("|")}|half)\\s+(?:(?:${voiceVocabulary("en").pillLikeMealWords.join("|")}|small|big|little)\\s+){0,2}ones?(?![A-Za-z])`,
    ].join("|"),
    "i",
  ),
  zh: /半\s*(?:个单位|单位|片|粒|颗|毫升)|[一两二三四五六七八九十0-9０-９]+\s*个\s*(?:白|蓝|黄|红|粉|绿|橙|黑|灰|紫|小|大)/,
});

/**
 * Round 5 (Critical 2, GATE ONLY): a treatment change in any inflection ("I stopped my dark pen", "I'm thinking of stopping my
 * metformin", 我停了二甲双胍, 不打了) withholds the whole transcript. "take" and "inject" are every factual medicine report (owner #4:
 * "I injected 10 units of the grey pen" stays a TAKEN candidate locally), so they withhold only with advice wording: should, supposed
 * to, ought to, tell me if ("Tell me if I should inject now"); a medicine noun with that wording withholds too.
 */
const GATE_TREATMENT_CHANGE: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /(?<![A-Za-z])(?:stop(?:s|ped|ping)?|skip(?:s|ped|ping)?|double(?:d|s)?|increase(?:d|s)?|reduce(?:d|s)?|doubling|increasing|reducing)(?![A-Za-z])/i,
  zh: /停了|不打了|不吃了|少打|多打|少吃|多吃|要不要|该不该|应不应该/,
});
const GATE_ADVICE: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /(?<![A-Za-z])(?:should|supposed\s+to|ought\s+to|tell\s+me\s+if)(?![A-Za-z])/i,
  zh: /应该|应不应该|该不该|是不是要|要不要|告诉我/,
});
const GATE_TREATMENT_VERB: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /(?<![A-Za-z])(?:take|takes|took|taking|taken|inject|injects|injected|injecting|use|using)(?![A-Za-z])/i,
  zh: /打|吃药|用药/,
});
function gateAdvisedTreatment(text: string, language: VoiceLanguage): boolean {
  return GATE_ADVICE[language].test(text) && (GATE_TREATMENT_VERB[language].test(text) || MATCHERS[language].noun.test(text));
}
