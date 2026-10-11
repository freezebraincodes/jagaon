/**
 * Packet 13 (P13S): the fixed built-in voice vocabulary `voice-vocabulary.13s.3` (13s.3: the safety re-review's Cr1–Cr4 and I1–I3
 * cue additions and the owner's reported-amount, health-question and default-unit decisions). Pure data. Patient terminology (remembered
 * phrase → canonical medicine) is NOT here: it is the patient's own record, passed to the extractor as data
 * (`VoiceMedicineDirectory`) and never learned implicitly.
 *
 * - The session language selects ONE vocabulary (`en` or `zh`). Mixed-language transcripts are unverified and are not combined.
 * - Every fact kind needs its OWN cue: a glucose cue for a reading, a meal cue for a meal, a medicine noun (or a remembered term or an
 *   exact canonical name) for a medicine occurrence. A unit or a number alone never makes a fact (review C2).
 * - Qualifiers are kept, never resolved: negation, uncertainty (including comparatives, targets, conditions, future, approximate and
 *   past times, review I1 and Cr3), corrections and other people (review I1/I2 and Cr1).
 * - Allow-lists, not deny-lists, decide what may sit before a glucose cue (first person only, else OTHER_PERSON: Cr1) and between the
 *   cue and its number (else the clause is not a reading: Cr2).
 * - English matching is case-insensitive and whole-word; Chinese matching is by substring.
 * - TRTC's number and punctuation formatting is unverified until a live run.
 *
 * 13s.4 (CR-11, owner decision R-5, 2026-10-11): spoken TENS 21–99 for glucose readings, never partial. English adds the tens words
 * (`tensWords`: twenty … ninety) with "<tens> <one–nine>" / "<tens>-<one–nine>" compounds; Chinese X十 / X十Y (二–九, 一–九) is parsed by
 * the extractor. Approximation followers (`approximationFollowers`: "sixty something", "-odd", "-ish"; Chinese 多/几/来 already make it
 * not a number) make the WHOLE number unsupported. Spoken hundreds stay unsupported (out of scope). `integerWords` is unchanged, so the
 * medicine, amount and redirect rules that read it are unchanged.
 */
export const VOICE_VOCABULARY_VERSION = "voice-vocabulary.13s.4";

export type VoiceVocabulary = Readonly<{
  glucoseCues: readonly string[];
  /** The only units that make a reading's unit stated (mmol/L); never followed by "/mol" (HbA1c). */
  mmolUnits: readonly string[];
  integerWords: readonly string[];
  /** 13s.4 (R-5): the tens words twenty … ninety, in order (value = (index + 2) × 10); glucose readings only. Empty for Chinese. */
  tensWords: readonly string[];
  /** 13s.4 (R-5): a word right after a spoken number that makes it approximate ("sixty something", "sixty-odd"): never a value. */
  approximationFollowers: readonly string[];
  digitWords: readonly string[];
  decimalMarker: string;
  /** A number followed by one of these is a time, a count or another unit, never a reading. */
  notReadingFollowers: readonly string[];
  /** Another measurement or substance named ANYWHERE in the clause: no number of that clause is a glucose reading (Cr2). */
  otherMeasureCues: readonly string[];
  negationCues: readonly string[];
  uncertaintyCues: readonly string[];
  correctionCues: readonly string[];
  otherPersonCues: readonly string[];
  /** Cr1: the only words that may precede a glucose cue in its clause; anything else makes the reading OTHER_PERSON. */
  preCueWords: readonly string[];
  /** Cr2: the only words that may sit between a glucose cue and its number (plus numbers and the qualifier cues); else no reading. */
  betweenWords: readonly string[];
  /** Meals: slot words and eating verbs. */
  mealSlots: Readonly<Record<"BREAKFAST" | "LUNCH" | "DINNER" | "SUPPER", readonly string[]>>;
  eatVerbs: readonly string[];
  /** Medicines: generic nouns (never a specific medicine) and occurrence status cues. */
  medicineNouns: readonly string[];
  statusUnknown: readonly string[];
  statusSkipped: readonly string[];
  statusPlanned: readonly string[];
  statusTaken: readonly string[];
  /** M2: a medicine clause about the object, not an occurrence (lost, bought, broken, left at home, an instruction relayed). */
  notOccurrenceCues: readonly string[];
  /** Owner #4: the unit words of an amount the person REPORTED for an occurrence ("10 units"), kept exactly as spoken. */
  amountUnits: readonly string[];
  /** I3: a meal clause that names a count, colour or medicine classifier and no food (吃了两颗白色的): never a meal. */
  pillLikeMealWords: readonly string[];
  /** Neutral redirect (review I3): dose/treatment terms, broad question cues, and the strict question forms of a treatment question. */
  doseTreatmentTerms: readonly string[];
  /** Owner #4: dose terms that are only a unit; with an explicit occurrence verb and no question they are a reported amount. */
  reportedAmountTerms: readonly string[];
  questionCues: readonly string[];
  treatmentQuestionForms: readonly string[];
  treatmentVerbs: readonly string[];
  /** Question forms that, with a glucose cue, make a health question about a reading (redirected; review I3). */
  healthQuestionForms: readonly string[];
  /** Owner #3: health-assessment content that is a HEALTH_QUESTION with any question form, or on its own (explicit). */
  healthTopics: readonly string[];
  healthExplicit: readonly string[];
  /** Owner #3: the ask forms that, with a health topic, make a health question (narrower than `questionForms`: no bare "which"). */
  healthAskForms: readonly string[];
  /** Cr4/I3: any question form (the remote-extraction gate withholds every transcript with one). */
  questionForms: readonly string[];
}>;

const EN_INTEGERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
] as const;
const EN_DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;
const EN_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/**
 * Recheck 6 (CRITICAL A): counterfactual wording. It is an uncertainty cue, and a "taken" beside it is never TAKEN (the status is
 * unclear): "I'd have taken my dark pen", "I would've injected", "could have", 我本来会打黑色的笔, 本该吃, 要是…就.
 * English cues match with the straight or curly apostrophe, or none.
 */
export const VOICE_COUNTERFACTUAL_CUES = Object.freeze({
  en: Object.freeze([
    "would", "would have", "would've", "i'd have", "we'd have", "'d have", "could have", "could've", "might have", "might've",
    "must have", "should have", "should've",
  ]),
  zh: Object.freeze(["本来会", "本来要", "本来", "本该", "本应", "就会", "要是"]),
});

export const VOICE_VOCABULARY_EN: VoiceVocabulary = Object.freeze({
  glucoseCues: Object.freeze(["blood sugar", "blood glucose", "sugar reading", "glucose reading", "sugar", "glucose"]),
  mmolUnits: Object.freeze([
    "millimoles per litre", "millimoles per liter", "millimole per litre", "millimole per liter", "mmol per litre", "mmol per liter",
    "mmol/l", "millimoles", "millimole", "mmol",
  ]),
  integerWords: Object.freeze([...EN_INTEGERS]),
  tensWords: Object.freeze(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]),
  approximationFollowers: Object.freeze(["something", "odd", "ish"]),
  digitWords: Object.freeze([...EN_DIGITS]),
  decimalMarker: "point",
  notReadingFollowers: Object.freeze([
    "am", "pm", "a.m.", "p.m.", "o'clock", "oclock",
    "mg/dl", "mg", "milligram", "milligrams", "kg", "kilo", "kilos", "percent", "%", "degree", "degrees", "mmol/mol",
    "time", "times", "tablet", "tablets", "pill", "pills", "unit", "units", "dose", "doses", "hour", "hours", "hr", "hrs",
    "minute", "minutes", "min", "mins", "day", "days", "week", "weeks", "month", "months", "year", "years", "step", "steps",
    "cup", "cups", "glass", "glasses", "meal", "meals", "people", "person", "persons", "book", "books", "page", "pages",
  ]),
  otherMeasureCues: Object.freeze([
    "weight", "cholesterol", "ketone", "ketones", "hba1c", "a1c", "potassium", "sodium", "pressure", "bp", "pulse", "heart rate",
    "temperature", "insulin", "units",
    // 13s.3 (Cr2): urine, drinks and food, and common analytes.
    "urine", "urinary", "tea", "coffee", "drink", "drinks", "juice", "food", "triglyceride", "triglycerides", "lactate", "uric acid",
    "lipid", "lipids", "creatinine", "hemoglobin", "haemoglobin", "ldl", "hdl", "egfr", "protein", "albumin", "oxygen",
  ]),
  negationCues: Object.freeze([
    "not", "no", "never", "n't", "none", "nothing", "cannot", "without",
    "isnt", "wasnt", "dont", "didnt", "doesnt", "cant", "wont", "couldnt", "shouldnt", "arent", "werent", "havent", "hasnt",
    // 13s.3 (I1)
    "hardly", "nope", "nah", "doubt", "false",
    // P13X review CRITICAL 1: the remaining apostrophe-less contractions (every "n't" / "n’t" form is matched by the extractor's
    // `n['’]t` rule and by the redirect matcher's straight-or-curly apostrophe).
    "hadnt", "wouldnt", "mustnt", "neednt", "aint",
  ]),
  uncertaintyCues: Object.freeze([
    "not sure", "unsure", "maybe", "might", "perhaps", "probably", "i think", "i guess", "about", "around", "roughly",
    "approximately", "or so", "remembered later", "don't remember", "can't remember", "don't know", "either", "or",
    "below", "under", "over", "above", "less than", "more than", "at least", "at most", "up to", "higher", "lower", "between",
    "target", "goal", "should", "supposed", "yesterday", "ago", "last time", "last night", "earlier",
    // 13s.3 (Cr3): targets, conditions, future, approximate, habitual and past values.
    "keep", "aim", "stay", "must", "if", "in case", "hits", "reaches", "will", "will be", "tomorrow", "approx", "normally", "usually",
    "typically", "average", "averages", "averaged", "exceed", "expected", "hope", "last week", "last month", "the other day", ...EN_WEEKDAYS,
    // 13s.3 round 4 (I2): doubt beside a reading ("Sugar 6.8, is that right?", "am I right?").
    "right", "correct", "sure", "is that right", "am i right",
    // Recheck 6 (CRITICAL A): a counterfactual is never an occurrence ("I'd have taken my dark pen", "I would've injected").
    ...VOICE_COUNTERFACTUAL_CUES.en,
  ]),
  correctionCues: Object.freeze(["sorry", "i mean", "i meant", "actually", "wait", "wrong", "correction", "rather", "scratch that"]),
  otherPersonCues: Object.freeze([
    "'s sugar", "'s blood", "'s glucose", "'s reading", "'s insulin", "'s medicine", "'s pill", "'s pen", "'s lunch", "'s breakfast", "'s dinner",
    "wife", "husband", "mother", "mom", "mum", "father", "dad", "son", "daughter", "friend", "brother", "sister", "grandma", "grandpa",
    "his", "her", "their", "he", "she", "they",
    // 13s.3 (Cr1)
    "kid", "kids", "child", "children", "baby", "grandmother", "grandfather", "granny", "grandson", "granddaughter", "aunt", "auntie",
    "aunty", "uncle", "cousin", "nephew", "niece", "partner", "patient", "your", "you", "our", "him", "them", "neighbour", "neighbor",
    "colleague", "relative", "family",
    // 13s.3 round 4 (C1): Singapore kinship terms and titles ("Ah Ma, sugar 7.2", "Mdm Tan").
    "ah ma", "ah mah", "ah gong", "ah kong", "ah po", "ah pa", "ah ba", "ah boy", "ah girl", "mdm", "madam", "mrs", "mr", "ms", "mister",
  ]),
  // 13s.3 round 4: "is" and "was" removed (a clause-initial "Is my sugar 7.2" is a question); demo phrasings added (I4).
  preCueWords: Object.freeze([
    "i", "i'm", "im", "my", "me", "mine", "myself", "um", "uh", "er", "erm", "so", "ok", "okay", "well", "and", "then", "also", "just",
    "oh", "hi", "hello", "yes", "yeah", "right", "now", "today", "this", "that", "morning", "afternoon", "evening", "night", "tonight",
    "earlier", "last", "at", "in", "on", "before", "after", "breakfast", "lunch", "dinner", "supper", "fasting", "when", "woke", "up",
    "checked", "check", "measured", "tested", "test", "got", "the", "a", "one", "first", "second", "said", "says", "for",
    "doctor", "nurse", "told", "according", "to", "finger", "prick", "meter", "two", "hour", "hours", "ago",
    "post", "meal", "post-meal", "walk", "exercise", "glucometer", "showed", "shows", "own", "bedtime", "sleep", "dawn",
  ]),
  betweenWords: Object.freeze([
    "was", "is", "are", "were", "been", "be", "being", "s", "at", "of", "for", "level", "levels", "reading", "readings", "read", "test",
    "tested", "check", "checked", "measured", "came", "back", "this", "morning", "afternoon", "evening", "night", "today", "tonight",
    "now", "just", "then", "fasting", "after", "before", "breakfast", "lunch", "dinner", "supper", "meal", "meals", "hour", "hours",
    "minutes", "mins", "i", "think", "guess", "less", "more", "than", "and", "to", "isn't", "wasn't", "can't", "high", "low", "but",
    "which", "my", "it", "went", "up", "down", "only", "still", "like", "so", "a", "the", "in", "on", "as", "even", "once", "again",
    "too", "very", "quite", "pretty", "fine", "okay", "ok", "result", "results", "number", "showed", "shows", "said", "says",
  ]),
  mealSlots: Object.freeze({
    BREAKFAST: Object.freeze(["breakfast"]),
    LUNCH: Object.freeze(["lunch"]),
    DINNER: Object.freeze(["dinner"]),
    SUPPER: Object.freeze(["supper"]),
  }),
  eatVerbs: Object.freeze(["ate", "eaten", "eat", "eating"]),
  medicineNouns: Object.freeze([
    "pills", "pill", "tablets", "tablet", "capsules", "capsule", "medicines", "medicine", "medications", "medication", "meds",
    "insulin", "pen", "injection", "jab",
  ]),
  statusUnknown: Object.freeze([
    "forgot", "forget", "forgotten", "remembered later", "not sure", "unsure", "don't remember", "dont remember", "can't remember",
    "cant remember", "maybe", "might have", "i think", "probably", "don't know", "dont know",
  ]),
  statusSkipped: Object.freeze([
    "skipped", "didn't take", "didnt take", "did not take", "didn't inject", "didnt inject", "did not inject", "didn't use",
    "didnt use", "did not use", "missed",
  ]),
  statusPlanned: Object.freeze([
    "need to", "needs to", "have to", "has to", "going to", "gonna", "will", "plan to", "about to", "later", "not yet",
    "haven't", "havent", "have not", "yet to",
  ]),
  statusTaken: Object.freeze(["took", "taken", "injected", "used", "did my", "had my", "gave myself", "done my"]),
  notOccurrenceCues: Object.freeze([
    "lost", "lose", "losing", "bought", "buy", "buying", "broken", "broke", "break", "left", "ran out", "run out", "running out",
    "refill", "expired", "pharmacy", "collected", "picked up", "doctor said", "nurse said", "told me", "prescribed",
  ]),
  amountUnits: Object.freeze(["units", "unit", "iu", "mg", "milligrams", "milligram", "tablets", "tablet", "pills", "pill", "capsules", "capsule", "ml", "puffs", "puff"]),
  pillLikeMealWords: Object.freeze(["one", "ones", "white", "blue", "yellow", "red", "pink", "green", "orange", "brown", "grey", "gray", "black", "purple"]),
  doseTreatmentTerms: Object.freeze([
    "dose", "doses", "dosage", "units", "how many", "how much", "increase", "reduce", "stop taking", "stop my", "stop the",
    "change my", "double my", "double dose", "extra dose", "more insulin", "less insulin", "skip",
    // 13s.3 (Cr4)
    // Round 4: "go up" / "go down" moved to the redirect's question-only WEAK terms (the gate still withholds them).
    "take more", "take less", "take another", "another one",
  ]),
  reportedAmountTerms: Object.freeze(["units"]),
  questionCues: Object.freeze(["should i", "can i", "do i", "need", "what", "how", "tell me", "ok to", "is it ok", "must", "?", "？"]),
  treatmentQuestionForms: Object.freeze(["should i", "can i", "do i", "must i", "is it ok", "ok to", "?", "？"]),
  treatmentVerbs: Object.freeze(["take", "inject", "stop", "skip", "change", "increase", "reduce", "double"]),
  healthQuestionForms: Object.freeze(["should i", "what should", "is that", "is it", "is this", "do i need", "dangerous", "hospital", "emergency", "what do i do", "?", "？"]),
  healthTopics: Object.freeze([
    "should i eat", "can i eat", "what can i eat", "what should i eat", "can i have", "should i have", "safe", "exercise", "fast",
    "fasting", "doctor", "hospital", "emergency", "dangerous", "bad", "normal", "too high", "too low", "dizzy", "shaky", "pain",
    "sick", "sweets", "snack", "sugar", "glucose", "what do i do", "what should i do", "see a doctor", "worried", "worry",
  ]),
  healthExplicit: Object.freeze(["dangerous", "hospital", "emergency", "help", "help me", "what do i do", "what should i do"]),
  healthAskForms: Object.freeze([
    "?", "？", "should i", "can i", "could i", "may i", "do i", "is it", "is that", "is this", "am i", "must i", "will i", "what can",
    "what should", "what do", "how do i", "how can i", "how should i", "ok to", "is it ok",
  ]),
  questionForms: Object.freeze([
    "?", "？", "should i", "should we", "can i", "could i", "may i", "do i", "did i", "does it", "is it", "is that", "is this", "am i",
    "must i", "shall i", "would it", "will i", "what", "how", "why", "which", "ok to", "is it ok", "can you", "could you", "would you",
    "will you", "do you",
  ]),
});

export const VOICE_VOCABULARY_ZH: VoiceVocabulary = Object.freeze({
  glucoseCues: Object.freeze(["血糖"]),
  mmolUnits: Object.freeze(["毫摩尔每升", "毫摩尔", "mmol/l", "mmol"]),
  integerWords: Object.freeze(["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]),
  tensWords: Object.freeze([]),
  // 13s.4: Chinese approximations (六十多, 六十几, 六十来) need no list: a number followed by any other Chinese character is not a number
  // at all (the extractor's existing follower rule), so the whole phrase stays not captured.
  approximationFollowers: Object.freeze([]),
  digitWords: Object.freeze(["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]),
  decimalMarker: "点",
  notReadingFollowers: Object.freeze(["毫克", "mg/dl", "mg", "kg", "%", "mmol/mol"]),
  otherMeasureCues: Object.freeze([
    "体重", "胆固醇", "酮", "血压", "体温", "心率", "脉搏", "钾", "钠", "胰岛素", "单位",
    // 13s.3 (Cr2)
    "尿", "茶", "咖啡", "饮料", "果汁", "糖化", "血红蛋白", "甘油三酯", "乳酸", "尿酸", "血脂", "肌酐", "蛋白", "血氧", "食物",
  ]),
  negationCues: Object.freeze(["不", "没", "没有", "未", "别", "并非", "非", "无", "否"]),
  uncertaintyCues: Object.freeze([
    "不确定", "不知道", "不清楚", "记不清", "可能", "大概", "好像", "也许", "左右", "差不多", "估计", "后来才想起", "或者", "还是", "吧",
    "低于", "高于", "超过", "少于", "多于", "大于", "小于", "之间", "目标", "应该", "昨天", "前天", "上次",
    // 13s.3 (Cr3)
    "控制在", "保持", "大约", "约", "上下", "以下", "以上", "平时", "一般", "平均", "通常", "明天", "如果", "要是", "的话", "上周",
    "上星期", "星期", "礼拜", "前几天", "会", "将", "希望",
    // 13s.3 round 4 (I2): doubt beside a reading (血糖六点八，对吗).
    "对吗", "对不对", "是吗", "没错吧", "对吧",
    // Recheck 6 (CRITICAL A): counterfactuals (我本来会打黑色的笔, 本该吃, 要是…就).
    ...VOICE_COUNTERFACTUAL_CUES.zh,
  ]),
  correctionCues: Object.freeze(["不对", "我是说", "其实", "错了", "说错", "应该说"]),
  otherPersonCues: Object.freeze([
    "妈妈", "爸爸", "母亲", "父亲", "老公", "老婆", "丈夫", "妻子", "太太", "先生", "儿子", "女儿", "朋友", "奶奶", "爷爷", "他", "她",
    // 13s.3 (Cr1)
    "妈", "爸", "孩子", "小孩", "宝宝", "阿姨", "叔叔", "婆婆", "公公", "外婆", "外公", "老伴", "病人", "你", "您", "姐", "哥", "弟",
    "妹", "孙", "舅", "姑", "伯", "婶", "家人", "同事", "邻居",
    // 13s.3 round 4 (C1): Singapore kinship terms (阿嬷, 阿公 ...).
    "阿嬷", "阿妈", "阿公", "阿婆", "阿伯", "阿叔", "嬷",
  ]),
  // 13s.3 round 4 (I4): 刚, 今早, 睡觉前, 运动后, 我自己 and similar demo phrasings added.
  preCueWords: Object.freeze([
    "我的", "我", "的", "今天", "昨天", "前天", "早上", "早晨", "上午", "中午", "下午", "晚上", "刚才", "刚刚", "现在", "餐前", "餐后",
    "饭前", "饭后", "空腹", "早餐前", "早餐后", "早饭前", "早饭后", "午饭前", "午饭后", "午餐前", "午餐后", "晚饭前", "晚饭后",
    "晚餐前", "晚餐后", "两小时", "小时", "后", "前", "测了", "测", "量了", "量", "医生说", "医生", "说", "嗯", "那个", "就是", "然后",
    "还有", "和", "这次", "上次", "第一次", "第二次", "睡前", "起床", "起来",
    "刚", "今早", "今晚", "睡觉前", "睡觉", "运动后", "运动前", "运动", "散步后", "我自己", "自己", "一下", "过",
  ]),
  betweenWords: Object.freeze([
    "是", "有", "为", "的", "测了", "测", "量了", "量", "读数", "值", "水平", "今天", "早上", "早晨", "上午", "中午", "下午", "晚上",
    "刚才", "现在", "第二次", "第一次", "次", "小时", "后", "前", "不到", "只有", "才", "不过", "都", "也", "又", "已经", "刚",
    "要在", "结果", "显示", "空腹", "餐后", "餐前", "饭后", "饭前",
  ]),
  mealSlots: Object.freeze({
    BREAKFAST: Object.freeze(["早餐", "早饭"]),
    LUNCH: Object.freeze(["午餐", "午饭", "中饭"]),
    DINNER: Object.freeze(["晚餐", "晚饭"]),
    SUPPER: Object.freeze(["夜宵", "宵夜"]),
  }),
  eatVerbs: Object.freeze(["吃了", "吃过", "吃"]),
  medicineNouns: Object.freeze(["胰岛素笔", "胰岛素", "药片", "药丸", "胶囊", "药", "针", "笔"]),
  statusUnknown: Object.freeze(["忘了", "忘记", "后来才想起", "不确定", "不记得", "好像", "可能", "也许"]),
  statusSkipped: Object.freeze(["没吃", "没打", "没有吃", "没有打", "没用", "没有用", "跳过", "漏了"]),
  statusPlanned: Object.freeze(["需要", "准备", "待会", "等一下", "等下", "一会儿", "还没", "打算", "要"]),
  statusTaken: Object.freeze(["吃了", "打了", "用了", "注射了", "已经"]),
  notOccurrenceCues: Object.freeze(["丢了", "弄丢", "买了", "去买", "坏了", "忘在家", "放在家", "没带", "用完", "过期", "医生说", "医生叫", "医生让", "开了", "拿药"]),
  // 13s.3 round 4: "mg" as in English, so a spoken mg amount is handled the same in both languages.
  amountUnits: Object.freeze(["个单位", "单位", "毫克", "片", "粒", "颗", "毫升", "mg"]),
  pillLikeMealWords: Object.freeze(["颗", "粒", "色的", "色那", "那颗", "一片", "两片"]),
  doseTreatmentTerms: Object.freeze([
    "剂量", "几片", "几个单位", "多少", "加量", "减量", "停药", "换药", "不打", "打多少", "多打", "少打", "多吃一片", "少吃一片", "多吃药", "少吃药",
    // 13s.3 (Cr4); round 4: the bare 加 / 停 count only with a question form (voice-advice-redirect WEAK terms), so the phrases are here.
    "加一片", "加药", "加打", "加大", "停打", "停吃", "停掉", "不吃了", "再打", "再吃",
  ]),
  reportedAmountTerms: Object.freeze([]),
  questionCues: Object.freeze(["应该", "要不要", "可以", "吗", "？", "?", "要", "需要", "该", "能", "能不能", "怎么"]),
  treatmentQuestionForms: Object.freeze(["吗", "？", "?", "要不要", "该不该", "能不能", "可不可以", "应不应该"]),
  treatmentVerbs: Object.freeze(["吃", "打", "用", "停"]),
  healthQuestionForms: Object.freeze(["怎么办", "危险", "医院", "急诊", "吗", "？", "?", "要不要", "该不该", "怎么"]),
  healthTopics: Object.freeze([
    "可以吃", "能吃", "吃什么", "该吃", "吃多少", "西瓜", "水果", "甜", "糖果", "运动", "医院", "医生", "看病", "危险", "头晕", "晕",
    "痛", "疼", "正常", "严重", "怎么办", "血糖", "高", "低", "饿", "担心",
    // Recheck 6 (must-fix): "Sugar 15 我要不要吃多一点" is a question that must not disappear in code-switched text.
    "要不要吃", "吃多一点", "吃少一点",
  ]),
  healthExplicit: Object.freeze(["怎么办", "危险", "医院", "急诊", "救命"]),
  healthAskForms: Object.freeze(["？", "?", "吗", "要不要", "能不能", "可不可以", "该不该", "应不应该", "怎么", "什么", "多少", "几", "是否"]),
  questionForms: Object.freeze(["？", "?", "吗", "呢", "要不要", "能不能", "可不可以", "该不该", "应不应该", "怎么", "什么", "为什么", "多少", "几", "是否", "行不行", "好不好", "对不对"]),
});

/** Han characters that may directly follow a Chinese reading (sentence particles); any other Han character joins a word. */
export const ZH_READING_PARTICLES = Object.freeze(["了", "啊", "吧", "呢", "的", "哦", "呀", "左"]);
/** Han characters that, directly before a Chinese number, make it an ordinal, weekday or date (第一, 星期六, 初三 ...). */
export const ZH_NOT_READING_PREFIXES = Object.freeze(["第", "期", "拜", "周", "初", "号", "月"]);
/** English determiners that make a following "one" a pronoun ("this one"), never a number. */
export const EN_PRONOUN_ONE_PREFIXES = Object.freeze(["the", "this", "that", "which", "each", "every", "any", "no", "another", "some"]);
/** English words never part of a spoken medicine description (the description is the 1–2 words right before the noun). */
export const EN_MEDICINE_PHRASE_STOPWORDS = Object.freeze([
  "i", "my", "the", "a", "an", "his", "her", "our", "your", "their", "of", "some", "this", "that", "to", "and", "or", "took", "take",
  "taken", "inject", "injected", "use", "used", "did", "had", "forgot", "need", "needs", "skipped", "missed", "with", "after", "before",
  "for", "at", "in", "on", "not", "no", "didn't", "didnt", "have", "has", "will", "gonna", "later", "yet", "done", "gave", "myself",
  // 13s.3: an amount and its unit before the noun ("10 units of my dark pen") are never part of the description.
  "units", "unit", "mg", "ml", "iu",
]);
/** Han characters that end a spoken Chinese medicine description (it is the text after the last of these, before the noun). */
export const ZH_MEDICINE_PHRASE_STOPS = Object.freeze([
  "了", "吃", "打", "用", "拿", "带", "我", "你", "他", "她", "把", "那", "这", "在", "要", "没", "有", "后", "前", "过", "位",
  // 13s.3: an amount (numeral and classifier) is never part of the description (两片药 → 药).
  "片", "粒", "颗", "个", "一", "二", "两", "三", "四", "五", "六", "七", "八", "九", "十",
]);

export function voiceVocabulary(language: "en" | "zh"): VoiceVocabulary {
  return language === "zh" ? VOICE_VOCABULARY_ZH : VOICE_VOCABULARY_EN;
}
