import type { AiLocale } from "@/domain/ai";
import { spelledCounts } from "../ai-output-validator";

/**
 * Packet 11B.6 shell lexicon (spec Section 8.2). Applied only to model-written shell text with slot tokens
 * removed; never to atoms. Stricter than r7: the model has no values, so any number or count word is
 * unsupported by definition. Every pattern is frozen and non-global.
 * Rules r2 (Packet 11B.7 hardening, owner decision 1): every scan reads a folded SCAN COPY (NFKC plus
 * apostrophe, double-quote, dash and space folding, format characters removed) so the unchanged owner-approved
 * word lists also catch typographic and full-width variants; the displayed shell text is never rewritten.
 * Any format or control character (Cf, or Cc other than tab, line feed and carriage return) is FORMAT_CHARACTER.
 * Fix round 1 (controller ruling): further apostrophe and quote folds, and DISALLOWED_CHARACTER — every character of
 * the folded scan copy must be in the locale allowlist (en-SG printable ASCII; zh-SG printable ASCII, CJK ideographs,
 * CJK symbols and punctuation, fullwidth forms), which closes combining marks, fillers and cross-script homoglyphs.
 * Rules r3 (owner list revision 2026-10-06, Packet 11B.8): content coverage, ADDITIVE only — the r1/r2 entries below are
 * unchanged; r3 adds the R3_RULE_TABLE and R3_DIRECTIVE entries, a closed Traditional→Simplified zh scan copy and the en
 * pair-joined candidates (visible word splits). Every r3 rule reads every scan copy; a match in any copy rejects.
 * Rules r4 (owner instruction 2026-10-06, Packet 11B.11, wording quality): every r1–r3 entry and scan copy is unchanged.
 * r4 adds (a) a meaningful-wording rule, gate S7b after S7 (`meaningfulWording` and its closed filler lists in
 * shell-validator.ts), applied to every EXPLAIN field and every care section intro, and (b) a zh-SG register rule for S7: the informal second
 * person 你 and 妳 (so 你们 and 妳們 too) in the model-written wording, read on the original text and every zh scan copy,
 * is LOCALE_INVALID with the evaluation-only detail register INFORMAL_SECOND_PERSON. 您 is accepted; en-SG is unaffected.
 * Rules r5 (owner instruction 2026-10-06, Packet 11B.12, clinical labels): every r1–r4 entry, table and scan copy is unchanged.
 * r5 adds the closed CLINICAL_LABEL_RULES (gate S6b in shell-validator.ts, after S5 and S6 and before S7): model-written shell
 * wording may not name a disease or condition, diagnosis, symptom, medication, treatment or other clinical label, read on every
 * scan copy (folded, look-alike, en pair/triple-joined candidates, zh joined and Traditional→Simplified copies), and a closed
 * r5 extension of the Traditional→Simplified map (R5_TRADITIONAL_TABLE, additive) for the Traditional forms of those entries.
 * Fact atoms are never scanned: every rule reads the shell text with its slot tokens removed.
 * Rules r6 (owner instruction 2026-10-06, Packet 11B.13, clinical-label boundary precision): every r1–r4 entry, table and scan
 * copy, the r3 join mechanism and the r5 T→S rows are unchanged; only the r5 clinical-label lists and their matcher change.
 * CLINICAL_LABEL_ENTRIES replaces the r5 rules: en entries are complete words with every inflection listed (no stem, prefix or
 * suffix rule) or exact phrases; zh entries are deliberate multi-character forms (the r5 single characters are gone, 癌 aside).
 * A closed list of neutral logistics phrases (CLINICAL_NEUTRAL_PHRASES) is masked before the labels are matched, and an additive
 * R6_TRADITIONAL_TABLE maps the Traditional forms the r6 entries and neutral phrases need. S6b keeps its gate and reason.
 * Rules r7 (owner instruction 2026-10-06, Packet 11B.14, contextual English up/down): bare "up" and "down" are removed from the
 * r1 COMPARATIVE_DIRECTION alternation (every other alternative and every zh form unchanged). R7_DIRECTION_CONTEXT, under the same
 * violation code and read on the same scan copies as that r1 entry, rejects genuine direction constructions instead: a listed
 * movement/state verb followed by up/down, and up/down followed by from/to/by unless up/down is the particle of a closed list of
 * note-taking/raising phrasal verbs. Every other r1–r6 entry, table, scan copy and join is unchanged.
 * Rules r8 (owner instruction 2026-10-07, Packet 11B.15, S6 placeholder provenance): every r1–r7 entry, table, scan copy and join is
 * unchanged, and no word list changes. S6 (shell-validator.ts) reads every match with its provenance: a match that splits a stand-in
 * occurrence (the neutral noun S6 reads in place of each token) is discarded, so checker text never manufactures a match (应 + the 该 of
 * 该项 is not 应该); and S6 also reads a token-separated copy (tokens as CLINICAL_TOKEN_SEPARATOR, read as a space) so model-written
 * splits across a token (应{{S2}}该, 建{{S2}}议) still reject. The helpers are standInShadow, standInOccurrence, provenanceSafeMatch,
 * shellDirectiveScanTexts and tokenSeparatedScanText below.
 * Rules r9 (owner decision 2026-10-09, Packet 11 FULL rejection diagnosis case 2, offline; never frozen on its own, shipped only inside
 * r10): exactly one change. In the r3 zh directive entry the bare alternative 留意 becomes (?<!所)留意, so the descriptive relative clause
 * 您所留意的 ("which you have been keeping an eye on") is no longer read as a directive. 请留意, 要留意, 需要留意 and every other
 * directive or urgency form still reject (要留意 keeps its own alternative; 需要 is r1).
 * Rules r10 (owner decision 2026-10-09, urgency-language assessment, offline; one freeze together with r9): ADDITIVE only — every r1–r9
 * entry, table, scan copy, join and provenance rule is unchanged. r10 adds the R10_DIRECTIVE entries (read by S6 exactly as the other
 * directive entries: every scan copy, the en pair/triple-joined candidates, the token-separated copy, stand-in provenance) and an
 * additive R10_TRADITIONAL_TABLE. They reject, in model-written shell wording only (S6 reads the REMOTE fields with every slot token
 * replaced; patient facts, historical content and fixed application notices are never read): a statement that something needs or
 * deserves the person's attention, an instruction to attend to, watch or monitor something, a risk judgement ("concerning", 令人担忧),
 * and the evaluative use of important / notable / noteworthy / worth noting / 重要 / 值得一提 that assigns importance or noteworthiness.
 * Context checks keep the descriptive forms (您所关注的, 您所留意的, 您所留心的, 您关注的, "notes concerning …", "the items you
 * paid attention to", "the items you marked as important", 您认为重要的) accepted. The FULL run under r8 stays FAIL; r9/r10 rescore nothing.
 * Rules r11 (owner decision 2026-10-11, salience option (a), offline): ADDITIVE only — every r1–r10 entry, table, scan copy, join and
 * provenance rule is unchanged. r11 adds the R11_DIRECTIVE entries (read by S6 exactly as the r10 entries) and an additive
 * R11_TRADITIONAL_TABLE. In model-written shell wording only, they reject the evaluative use of significant(ly), crucial(ly) and key,
 * the attention imperatives look closely, notice (imperative or "you may/will notice"), keep in mind and "… to watch", and the zh
 * salience words 重点, 关键 and 显著. Context checks keep descriptive forms accepted ("the items you noticed", "the readings you chose
 * to watch", "the items you marked as significant", "the entries you keyed in", 关键词, 您认为关键的), and every r10 approved form stays
 * accepted. The recorded FULL run stays FAIL; r11 rescores nothing.
 * Rules r12 (owner decision 2026-10-11, with the policy-led prompt 11b.20, offline): ADDITIVE only — every r1–r11 entry, table, scan
 * copy, join and provenance rule is unchanged. r12 adds the R12_DIRECTIVE entries (read by S6 exactly as the r10/r11 entries) and an
 * additive R12_TRADITIONAL_TABLE. In model-written shell wording only, four claim shapes reject, each needing a holder and an assertion
 * in the same clause: F1 a judgement of the person's data ("these results look good", "the readings that stand out", 突出的记录), F2 a
 * benefit or cause of an activity or treatment ("your walks are helping", 散步对您有帮助), F3 a completed-state claim ("have been
 * saved", "your care team has these", 已经保存), F4 an attributed feeling ("you may be feeling worried", 您可能会感到). The person's own
 * marking, regarding, recording and choosing stay accepted, as do every r10 and r11 approved form. Fix round 1 (independent review, label
 * unchanged because r12 is uncommitted and has no bound evidence): the F2 holder is narrowed to an activity or treatment; the zh frames
 * read clause-preserving copies (S6 role CLAUSE in shell-validator.ts); the zh F3 exemption reads the person's own earlier action; the
 * plain forms of the four shapes are added inside the same frames. The recorded FULL run stays FAIL.
 */
export const SHELL_RULES_REVISION = "ai-shell-rules.11b.18-r12";
export type ShellLexicalViolation = "DIGIT" | "NUMBER_WORD" | "UNIT" | "PERCENT" | "REFERENCE" | "DATE_OR_TIME" | "COMPARATIVE_DIRECTION" | "MEASURE_NAME" | "QUOTATION" | "FORMAT_CHARACTER" | "DISALLOWED_CHARACTER";

/** Format (Cf) and control (Cc) characters, except tab, line feed and carriage return. */
const FORMAT_CHARACTER = Object.freeze(/(?![\t\n\r])[\p{Cf}\p{Cc}]/u);
/** Per code point folds; a lookup table, so no global pattern (and no lastIndex state) exists. */
const FOLD_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["’‘‛ʼʹ′＇`´\u02BB\u02BD\u02C8\uA78C\u055A\u05F3\u2035\u1FBF\u1FBD", "'"],
  ["“”„‟″＂«»\u275D\u275E\u2039\u203A\u301D\u301E\u301F\u02EE", '"'],
  ["‐‑‒–—―−", "-"],
  ["\u00A0\u202F\u2007\u3000", " "],
];
/** Characters outside the locale allowlist of the folded scan copy (non-global; one test per text). */
const DISALLOWED: Readonly<Record<AiLocale, RegExp>> = Object.freeze({
  "en-SG": Object.freeze(/[^\u0020-\u007E]/u),
  // Fix round 2: the CJK symbols and punctuation part is exactly U+3000–U+3003, U+3008–U+3011 and U+3014–U+301C.
  "zh-SG": Object.freeze(/[^\u0020-\u007E\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u3003\u3008-\u3011\u3014-\u301C\uFF01-\uFF60\uFFE0-\uFFE6]/u),
});
/** Fix round 4: stroke ideographs (丶 丨 丿 乀 乁 亅 乛) are removed from the zh allowlist (original and folded checks). */
const ZH_EXCLUDED_IDEOGRAPHS = Object.freeze(/[\u4E36\u4E28\u4E3F\u4E40\u4E41\u4E85\u4E5B]/u);
const outsideAllowlist = (text: string, locale: AiLocale): boolean => DISALLOWED[locale].test(text) || (locale === "zh-SG" && ZH_EXCLUDED_IDEOGRAPHS.test(text));
/** Fix round 2: any combining mark left in the scan copy is disallowed in both locales (belt and braces). */
const COMBINING_MARK = Object.freeze(/\p{M}/u);
/** Whitespace between two CJK ideographs; a fresh global matcher per call, so no lastIndex state is shared. */
const ideographGap = (): RegExp => /(?<=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])\s+(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/gu;
/**
 * Fix round 3: punctuation, symbols and whitespace between two CJK ideographs; fix round 4: also a single ASCII letter
 * standing alone there (optionally with such separators around it). A fresh global matcher per call.
 */
const ideographSeparator = (): RegExp => /(?<=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])(?:[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]*[A-Za-z][\p{P}\p{S}\s]*)(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/gu;
/**
 * Fix round 4 zh look-alikes (on the folded copy, where every dash form is already "-" and ＋ ＝ are + =).
 * Rules r3 fix round 1: a dash reads as 一 only when it stands alone (not adjacent to another dash), so —— stays punctuation.
 */
const ZH_LOOK_ALIKES: ReadonlyMap<string, string> = new Map([["-", "一"], ["+", "十"], ["=", "二"]]);
const zhLookAlike = (scan: string): string => {
  const characters = Array.from(scan);
  return characters.map((character, index) => (character === "-" && (characters[index - 1] === "-" || characters[index + 1] === "-") ? character : ZH_LOOK_ALIKES.get(character) ?? character)).join("");
};
/** Fix round 4 en look-alikes: uppercase I and | read as l, rn as m, vv as w; fresh global matchers per call. */
const enLookAlike = (scan: string): string => scan.replace(/[I|]/g, "l").replace(/rn/g, "m").replace(/vv/g, "w");
const FOLDS: ReadonlyMap<string, string> = new Map(FOLD_TABLE.flatMap(([characters, replacement]) => [...characters].map((character) => [character, replacement] as const)));
const foldPunctuation = (text: string): string => Array.from(text, (character) => FOLDS.get(character) ?? character).join("");

/**
 * The scan copy of a shell text (rules r2). Punctuation is folded before NFKC (so ´ and ″ keep their meaning
 * instead of decomposing) and again after it (so full-width and compatibility forms fold too); format and
 * control characters are removed so they cannot split a listed word. For zh-SG (fix round 2), whitespace between two
 * CJK ideographs is removed as well, so a gap cannot split a listed word either. Used only for scanning.
 */
export function foldShellScanText(text: string, locale?: AiLocale): string {
  const folded = Array.from(foldPunctuation(foldPunctuation(text).normalize("NFKC")))
    .filter((character) => !FORMAT_CHARACTER.test(character))
    .join("");
  if (locale === "zh-SG") return folded.replace(ideographGap(), "");
  // Fix round 4: the en scan copy reads "_" as a space, so underscore emphasis cannot hide a listed word.
  return locale === "en-SG" ? folded.replaceAll("_", " ") : folded;
}

/**
 * Fix round 3: the second zh scan copy — the zh scan copy with every punctuation, symbol and whitespace run between
 * two CJK ideographs removed, repeated until stable, so 建、议, 建（议） and 建…议 read as 建议. Scanning only.
 */
export function joinedZhScanText(scan: string): string {
  let current = scan;
  for (let next = current.replace(ideographSeparator(), ""); next !== current; next = current.replace(ideographSeparator(), "")) current = next;
  return current;
}

/**
 * Rules r3: a closed Traditional→Simplified character map holding the Traditional form of every character of the zh
 * entries of this lexicon (r1/r2/r3, DIRECTIVE included), the spelled-count measure words and the zh rules of the
 * shared legacy meaning rules (read by S6, unchanged) whose Traditional form differs. Each row is [simplified, its Traditional forms]. Scanning only.
 * Fix round 1: 參 reads as 参 (參考, 參加); the financial numeral 叁 keeps its Traditional form 叄.
 */
const TRADITIONAL_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["万", "萬"], ["两", "兩"], ["严", "嚴"], ["个", "個"], ["为", "為爲"], ["么", "麼麽"], ["于", "於"], ["亿", "億"], ["从", "從"], ["们", "們"],
  ["会", "會"], ["体", "體"], ["俩", "倆"], ["关", "關"], ["内", "內"], ["况", "況"], ["准", "準"], ["减", "減"], ["几", "幾"], ["删", "刪"],
  ["别", "別"], ["剂", "劑"], ["务", "務"], ["医", "醫"], ["单", "單"], ["厘", "釐"], ["叁", "叄"], ["参", "參"], ["双", "雙"], ["发", "發髮"], ["变", "變"],
  ["号", "號"], ["后", "後"], ["周", "週"], ["嘱", "囑"], ["围", "圍"], ["处", "處"], ["复", "復複"], ["审", "審"], ["导", "導"], ["将", "將"],
  ["尔", "爾"], ["尽", "盡儘"], ["岛", "島"], ["并", "並併"], ["应", "應"], ["异", "異"], ["张", "張"], ["归", "歸"], ["当", "當"], ["录", "錄"],
  ["忧", "憂"], ["恶", "惡噁"], ["护", "護"], ["担", "擔"], ["据", "據"], ["数", "數"], ["断", "斷"], ["无", "無"], ["时", "時"], ["显", "顯"],
  ["条", "條"], ["来", "來"], ["标", "標"], ["检", "檢"], ["没", "沒"], ["注", "註"], ["测", "測"], ["涨", "漲"], ["点", "點"], ["着", "著"],
  ["确", "確"], ["碍", "礙"], ["礼", "禮"], ["种", "種"], ["笔", "筆"], ["系", "係繫"], ["紧", "緊"], ["组", "組"], ["经", "經"], ["结", "結"],
  ["给", "給"], ["继", "繼"], ["续", "續"], ["胶", "膠"], ["范", "範"], ["药", "藥"], ["虑", "慮"], ["视", "視"], ["计", "計"], ["认", "認"],
  ["议", "議"], ["记", "記"], ["访", "訪"], ["证", "證証"], ["诊", "診"], ["该", "該"], ["说", "說説"], ["请", "請"], ["读", "讀"], ["调", "調"],
  ["贰", "貳"], ["车", "車"], ["转", "轉"], ["较", "較"], ["达", "達"], ["过", "過"], ["还", "還"], ["这", "這"], ["进", "進"], ["释", "釋"],
  ["里", "裡裏"], ["针", "針"], ["钟", "鐘鍾"], ["错", "錯"], ["问", "問"], ["阅", "閱"], ["陆", "陸"], ["险", "險"], ["随", "隨"], ["项", "項"],
  ["顺", "順"], ["须", "須鬚"], ["顿", "頓"], ["预", "預"], ["颗", "顆"], ["题", "題"], ["风", "風"], ["马", "馬"], ["疗", "療"], ["岁", "歲"],
  ["吃", "喫"], ["资", "資"], ["升", "昇陞"],
];
/**
 * Rules r5 (additive; the r3 rows above are unchanged): the Traditional form of every character of the r5 clinical-label rules
 * whose Traditional form differs and is not already mapped, plus 臟 (臟器, 心臟) and 鬱 (憂鬱, 抑鬱). Each row is [simplified,
 * its Traditional forms]; 牀 is the variant form of 床 (臨牀). Scanning only.
 */
const R5_TRADITIONAL_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["压", "壓"], ["肿", "腫"], ["郁", "鬱"], ["痴", "癡"], ["癫", "癲"], ["痫", "癇"], ["贫", "貧"], ["症", "癥"], ["烧", "燒"], ["热", "熱"],
  ["头", "頭"], ["晕", "暈"], ["呕", "嘔"], ["劳", "勞"], ["术", "術"], ["临", "臨"], ["学", "學"], ["床", "牀"], ["脏", "臟"],
  // r5 fix round 1: the variant 葯 (药), 鍼 (针), and the Traditional forms the added zh entries need.
  ["药", "葯"], ["针", "鍼"], ["适", "適"], ["难", "難"], ["胆", "膽"], ["状", "狀"], ["伤", "傷"], ["泻", "瀉"], ["闷", "悶"], ["气", "氣"],
  ["输", "輸"], ["开", "開"], ["验", "驗"],
];
/**
 * Rules r6 (additive; the r3 and r5 rows above are unchanged): the Traditional forms the r6 clinical-label forms (误诊, 传染病,
 * 肾病, 关节炎, 后遗症, 肿胀, 红肿, 干咳/干呕, 挂点滴) and neutral phrases (门诊, 护理团队/医疗团队, 预约) need. Scanning only.
 */
const R6_TRADITIONAL_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["误", "誤"], ["传", "傳"], ["肾", "腎"], ["节", "節"], ["遗", "遺"], ["胀", "脹"], ["红", "紅"], ["干", "乾幹"], ["挂", "掛"],
  ["门", "門"], ["团", "團"], ["队", "隊"], ["约", "約"],
  // r6 fix round 1: the Traditional forms the sibling forms need (喉咙痛, 心绞痛, 肠炎, 风湿/湿疹, 治愈).
  ["咙", "嚨"], ["绞", "絞"], ["肠", "腸"], ["湿", "濕溼"], ["愈", "癒"],
  // r6 fix round 1: 病历 joined the neutral list (病歷, 病曆).
  ["历", "歷曆"],
  // r6 fix round 2: 脚痛/脚疼 (腳) and 膝盖痛/膝盖疼 (膝蓋).
  ["脚", "腳"], ["盖", "蓋"],
];
/**
 * Rules r10 (additive; the r3, r5 and r6 rows above are unchanged): the Traditional forms the r10 zh directive entries need (观察, 追踪,
 * 跟踪, 仔细, 监测, 让人, 觉得). Scanning only.
 */
const R10_TRADITIONAL_TABLE: ReadonlyArray<readonly [string, string]> = [["观", "觀"], ["踪", "蹤"], ["细", "細"], ["监", "監"], ["让", "讓"], ["觉", "覺"]];
/** Rules r11 (additive; every row above is unchanged): the Traditional forms the r11 zh entries need (关键, and 关键词 kept open). Scanning only. */
const R11_TRADITIONAL_TABLE: ReadonlyArray<readonly [string, string]> = [["键", "鍵"], ["词", "詞"]];
/**
 * Rules r12 (additive; every row above is unchanged): the Traditional forms the r12 zh entries need (稳定, 运动, 锻炼, 饮食, 帮助, 见效, 这样,
 * 对您, 确实, 准备, 回顾, 带去, 沟通, 讨论, 存档, 储存, 药剂师, 现在, 拥有, 也许, 有点儿, 疲惫, 高兴, 沮丧, 烦, 孤独, 困扰, 满意, 轻松, 气馁, 骄傲,
 * 蛮, 点击, 选出; fix round 1: 刚才/刚刚). Scanning only.
 */
const R12_TRADITIONAL_TABLE: ReadonlyArray<readonly [string, string]> = [["蛮", "蠻"], ["稳", "穩"], ["击", "擊"], ["选", "選"], ["运", "運"], ["动", "動"], ["锻", "鍛"], ["炼", "煉"], ["饮", "飲"], ["样", "樣"], ["对", "對"], ["实", "實"], ["帮", "幫"], ["见", "見"], ["备", "備"], ["顾", "顧"], ["带", "帶"], ["沟", "溝"], ["讨", "討"], ["论", "論"], ["档", "檔"], ["储", "儲"], ["师", "師"], ["现", "現"], ["拥", "擁"], ["许", "許"], ["儿", "兒"], ["惫", "憊"], ["兴", "興"], ["丧", "喪"], ["烦", "煩"], ["独", "獨"], ["扰", "擾"], ["满", "滿"], ["轻", "輕"], ["松", "鬆"], ["馁", "餒"], ["骄", "驕"],
  // r12 fix round 1: 刚 for the person-did window (刚才, 刚刚).
  ["刚", "剛"],
  // r12 fix round 2: 维 for the holder-independent benefit target (维持).
  ["维", "維"]];
/** Traditional character → Simplified character (rules r3, extended by r5, r6, r10, r11 and r12); read-only by contract, used only to build scan copies. */
export const TRADITIONAL_TO_SIMPLIFIED: ReadonlyMap<string, string> = new Map([...TRADITIONAL_TABLE, ...R5_TRADITIONAL_TABLE, ...R6_TRADITIONAL_TABLE, ...R10_TRADITIONAL_TABLE, ...R11_TRADITIONAL_TABLE, ...R12_TRADITIONAL_TABLE].flatMap(([simplified, traditional]) => [...traditional].map((character) => [character, simplified] as const)));
const toSimplified = (scan: string): string => Array.from(scan, (character) => TRADITIONAL_TO_SIMPLIFIED.get(character) ?? character).join("");

/**
 * Rules r3: the en pair-joined candidates of the scan copies — every concatenation of two or three adjacent letter runs
 * separated by exactly one separator (space, hyphen, underscore, period, apostrophe, slash), so "Pl ease", "Sug-gest" and
 * "Pl ea se" read as Please, Suggest and Please. Each candidate is tested as a standalone word, never as a substring.
 */
export function pairJoinedCandidates(copies: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const copy of copies) {
    const runs = [...copy.matchAll(/[A-Za-z]+/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
    const joinable = (index: number) => runs[index + 1]!.start - runs[index]!.end === 1 && " -_.'/".includes(copy[runs[index]!.end]!);
    for (let index = 0; index + 1 < runs.length; index += 1) {
      if (!joinable(index)) continue;
      candidates.add(runs[index]!.text + runs[index + 1]!.text);
      if (index + 2 < runs.length && joinable(index + 1)) candidates.add(runs[index]!.text + runs[index + 1]!.text + runs[index + 2]!.text);
    }
  }
  return [...candidates];
}

/**
 * The scan copies the word-list rules and S6 read; a match in any copy rejects.
 * zh-SG: the scan copy, its joined copy (fix round 3) and the joined look-alike copy (fix round 4: dash forms → 一,
 * + → 十, = → 二, mapped before joining so a mapped numeral is never removed as a separator).
 * en-SG: the scan copy ("_" read as a space), the scan copy with "_" kept (so mmol_l and mg_dl still read as units) and
 * the look-alike copy (fix round 4).
 */
export function shellScanCopies(text: string, locale: AiLocale): readonly string[] {
  const scan = foldShellScanText(text, locale);
  if (locale === "zh-SG") {
    const copies = [scan, joinedZhScanText(scan), joinedZhScanText(zhLookAlike(scan))];
    // Rules r3: the T→S copy of each zh copy, appended only when it differs from every copy already listed.
    for (const copy of copies.slice()) {
      const simplified = toSimplified(copy);
      if (!copies.includes(simplified)) copies.push(simplified);
    }
    return copies;
  }
  return [scan, foldShellScanText(text), enLookAlike(scan)];
}
/** The copies the other S5 rules (DIGIT, PERCENT, REFERENCE, QUOTATION) read: the scan copy (en: also with "_" kept). */
const baseScanCopies = (copies: readonly string[], locale: AiLocale): readonly string[] => (locale === "zh-SG" ? copies.slice(0, 1) : copies.slice(0, 2));

/**
 * Fix round 3: the ORIGINAL text (before any folding or gap removal) may hold only allowlisted characters or the
 * explicit fold sources of the fold table; this refuses compatibility forms that NFKC would turn into allowlisted text.
 */
const originalOutsideAllowlist = (text: string, locale: AiLocale): boolean => Array.from(text).some((character) => outsideAllowlist(character, locale) && !FOLDS.has(character));
/** Word-list rules that read every scan copy (fix round 3; UNIT added in fix round 4); the others read the base copies. */
const WORD_LIST_RULES: ReadonlySet<ShellLexicalViolation> = new Set<ShellLexicalViolation>(["NUMBER_WORD", "DATE_OR_TIME", "COMPARATIVE_DIRECTION", "MEASURE_NAME", "UNIT"]);

const RULE_TABLE: ReadonlyArray<readonly [ShellLexicalViolation, RegExp]> = [
  ["DIGIT", /[0-9０-９]/],
  ["NUMBER_WORD", /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozens?|both|pairs?|couple|single|once|twice|several|multiple)\b|两者|二者|俩|双|几次|多次|数次/i],
  ["UNIT", /mmol\s*\/\s*l|mg\s*\/\s*dl|\b(?:kg|cm|lbs?|ml|mcg|mg|mmol_l|mg_dl)\b|公斤|厘米|毫升|毫克|微克/i],
  ["PERCENT", /[%％]/],
  ["REFERENCE", /\b(?:fact|claim|option|record|section|limitation)-\d+/i],
  ["DATE_OR_TIME", /\b(?:january|february|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow|tonight|ago|(?:last|this|next)\s+(?:week|weekend|month|year))\b|今天|昨天|明天|前天|后天|今晚|昨晚|上周|本周|下周|这周|上个?月|本月|下个?月|今年|去年|明年|(?:星期|周|礼拜)[一二三四五六日天]|[一二三四五六七八九十]+[月日号]/i],
  // Rules r7: bare "up" and "down" removed (R7_DIRECTION_CONTEXT below); every other alternative unchanged.
  ["COMPARATIVE_DIRECTION", /\b(?:rose|rises?|risen|rising|fell|falls?|fallen|falling|increas\w*|decreas\w*|higher|lower|more|less|improv\w*|worse\w*|better|drop\w*|climb\w*|jump\w*|declin\w*|grew|grow\w*)\b|上升|下降|升高|降低|增加|减少|更高|更低|变好|变差|好转|恶化|上涨|下跌|提高|回落/i],
  ["MEASURE_NAME", /\b(?:glucose|blood\s+sugar|sugar\s+levels?|weight|ketones?|insulin|a1c|hba1c)\b|血糖|体重|酮|胰岛素/i],
  ["QUOTATION", /["“”„‟«»「」『』]/],
];
const RULES: ReadonlyArray<readonly [ShellLexicalViolation, RegExp]> = Object.freeze(RULE_TABLE.map(([violation, pattern]) => Object.freeze([violation, Object.freeze(pattern)] as const)));

/**
 * Rules r7 (owner instruction 2026-10-06): contextual English up/down, reported as COMPARATIVE_DIRECTION and read on the same scan
 * copies as the r1 entry (folded, "_" read as a space, "_" kept, look-alike; zh copies too, for Latin words inside zh wording).
 * Words are separated by any run of whitespace or hyphens (the folded copies already read every dash form as "-").
 * (a) a listed movement/state verb (or the contracted is/are, 's and 're) followed by up or down: "went down", "is up", "was up";
 * (b) up or down followed by from, to or by ("down to", "up from"), EXCEPT when up/down is the particle of a closed list of
 *     non-measurement phrasal verbs right before it, optionally with one object pronoun between them ("noted down to share",
 *     "wrote these down to bring along"). The exception never suppresses (a). Every pattern is frozen and non-global.
 * Fix round 1 (controller rulings): come/came/comes/coming count with down only ("Questions that came up" passes; "came down"
 * rejects); "up to date" / "up-to-date" is not a direction (in (a) and (b)); one optional closed-list adverb may sit between the
 * verb and up/down ("went slightly down", "is still up"); the negated be/have forms isn't … hadn't count as verbs; and the en-SG
 * split-rejoined copies (r3 join limits) are read too, counting only a match that covers the rejoined word ("we nt down").
 * Fix round 2 (controller rulings): every inflection of the listed verbs (be and have included; the come-forms keep come + up);
 * one closed-list modifier between up/down and from/to/by ("up slightly from"); the phrasal exemption never applies when
 * from/to/by is followed by a slot token or a digit (R7_TOKEN_GUARD, read on the token-bearing field text S5 passes, and on the
 * token-free copies for digits); the global matchers are hoisted and the split pass runs only when nothing else matched.
 */
const R7_DIRECTION_VERBS = "go|goes|going|went|gone|am|is|are|was|were|be|been|being|has|have|had|having|move|moves|moved|moving|trend|trends|trended|trending|head|heads|headed|heading|tick|ticks|ticked|ticking|edge|edges|edged|edging|shoot|shoots|shot|shooting|spike|spikes|spiked|spiking|stay|stays|stayed|staying|remain|remains|remained|remaining|creep|creeps|crept|creeping";
/** Fix round 1: the come-forms count with "down" only ("Questions that came up" is neutral wording). */
const R7_COME_VERBS = "came|come|comes|coming";
/** Fix round 1: negated be/have forms (typographic apostrophes are already folded to "'" in every scan copy). */
const R7_NEGATED_VERBS = "isn't|wasn't|aren't|weren't|hasn't|haven't|hadn't";
/** Fix round 1: the closed list of adverbs that may sit (once) between the verb and up/down. */
const R7_ADVERBS = "slightly|now|still|also|further|back|right|way|all|even|much";
const R7_PHRASAL_VERBS = "note|notes|noted|noting|write|writes|wrote|written|writing|jot|jots|jotted|jotting|take|takes|took|taken|taking|bring|brings|brought|bringing|put|puts|putting";
const R7_OBJECT_PRONOUNS = "it|them|these|those|this|that";
const R7_GAP = String.raw`[\s-]+`;
/** The verb-to-particle gap: one optional closed-list adverb (fix round 1). */
const R7_VERB_GAP = String.raw`(?:${R7_GAP}(?:${R7_ADVERBS}))?${R7_GAP}`;
/** Fix round 2: at most one closed-list modifier between up/down and from/to/by ("a little" and "a bit" are one slot). */
const R7_MODIFIERS = String.raw`slightly|sharply|somewhat|further|back|again|steadily|gradually|a${R7_GAP}little|a${R7_GAP}bit`;
const R7_MODIFIER_SLOT = String.raw`(?:(?:${R7_MODIFIERS})${R7_GAP})?`;
/** Fix round 1: "up" not starting "up to date" / "up-to-date". */
const R7_UP_NOT_DATE = String.raw`up\b(?!${R7_GAP}to${R7_GAP}date\b)`;
/**
 * The exception words also read in the look-alike copy, where an uppercase I has become l ("WRITE" → "WRlTE"), so all-caps
 * phrasal wording is exempt on every copy alike; only the exception's own words are widened this way, never the rejecting patterns.
 */
const lookAlikeTolerant = (alternation: string): string => alternation.replaceAll("i", "[il]");
const R7_DIRECTION_CONTEXT: readonly RegExp[] = Object.freeze([
  new RegExp(String.raw`(?:\b(?:${R7_DIRECTION_VERBS}|${R7_NEGATED_VERBS})|'(?:s|re))${R7_VERB_GAP}(?:${R7_UP_NOT_DATE}|down\b)`, "i"),
  new RegExp(String.raw`\b(?:${R7_COME_VERBS})${R7_VERB_GAP}down\b`, "i"),
  new RegExp(String.raw`(?<!\b(?:${lookAlikeTolerant(R7_PHRASAL_VERBS)})(?:${R7_GAP}(?:${lookAlikeTolerant(R7_OBJECT_PRONOUNS)}))?${R7_GAP})\b(?:down${R7_GAP}${R7_MODIFIER_SLOT}(?:from|to|by)|up${R7_GAP}(?:(?:${R7_MODIFIERS})${R7_GAP}(?:from|to|by)|from|by|to(?!${R7_GAP}date\b)))\b`, "i"),
  // Fix round 2: the token/digit guard — no exemption when from/to/by is followed by a slot token or a digit.
  new RegExp(String.raw`\b(?:up|down)${R7_GAP}${R7_MODIFIER_SLOT}(?:from|to|by)(?=\s*(?:\{\{S\d{1,2}\}\}|[0-9]))`, "i"),
].map((pattern) => Object.freeze(pattern)));
/** Fix round 2: the token/digit guard alone (read on the token-bearing copies, where the other patterns add nothing). */
const R7_TOKEN_GUARD = R7_DIRECTION_CONTEXT[3]!;
/** Fix round 2: hoisted global matchers for the split pass (String.prototype.matchAll clones them, so no lastIndex is shared). */
const R7_DIRECTION_GLOBAL: readonly RegExp[] = Object.freeze(R7_DIRECTION_CONTEXT.map((pattern) => Object.freeze(new RegExp(pattern.source, "gi"))));
const R7_TOKEN_GUARD_GLOBAL: readonly RegExp[] = Object.freeze([R7_DIRECTION_GLOBAL[3]!]);
/** A rule's match on one scan copy; COMPARATIVE_DIRECTION also matches through the r7 contextual patterns. */
const ruleMatches = (violation: ShellLexicalViolation, pattern: RegExp, copy: string): boolean =>
  pattern.test(copy) || (violation === "COMPARATIVE_DIRECTION" && R7_DIRECTION_CONTEXT.some((context) => context.test(copy)));
/**
 * Rules r7 fix round 1: the en-SG split-rejoined copies — each scan copy with exactly one r3 join applied in place (two or three
 * adjacent letter runs separated by exactly one of space - _ . ' /, the pairJoinedCandidates limits), with the rejoined word's span.
 */
function splitRejoinedCopies(copies: readonly string[]): Array<Readonly<{ text: string; start: number; end: number }>> {
  const rejoined: Array<Readonly<{ text: string; start: number; end: number }>> = [];
  for (const copy of copies) {
    const runs = [...copy.matchAll(/[A-Za-z]+/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
    const joinable = (index: number) => runs[index + 1]!.start - runs[index]!.end === 1 && " -_.'/".includes(copy[runs[index]!.end]!);
    const join = (first: number, last: number) => {
      const word = runs.slice(first, last + 1).map((run) => copy.slice(run.start, run.end)).join("");
      rejoined.push({ text: copy.slice(0, runs[first]!.start) + word + copy.slice(runs[last]!.end), start: runs[first]!.start, end: runs[first]!.start + word.length });
    };
    for (let index = 0; index + 1 < runs.length; index += 1) {
      if (!joinable(index)) continue;
      join(index, index + 1);
      if (index + 2 < runs.length && joinable(index + 1)) join(index, index + 2);
    }
  }
  return rejoined;
}
/** A contextual match in a rejoined copy counts only when it covers part of the rejoined word (hoisted global matchers). */
const splitDirection = (copies: readonly string[], patterns: readonly RegExp[]): boolean =>
  splitRejoinedCopies(copies).some(({ text, start, end }) =>
    patterns.some((context) => [...text.matchAll(context)].some((match) => match.index < end && match.index + match[0].length > start)),
  );

/**
 * Rules r3 entries (owner list revision 2026-10-06), additive to RULE_TABLE. Each reads every scan copy (en: plus the
 * pair-joined candidates). en entries are whole-word and case-insensitive, except the capitalised month and weekday forms
 * (May, March, Mon, Tue(s), Wed, Thu(r)(s), Fri, Sat, Sun), which are case-sensitive so the modal "may" and the verb
 * "march" stay usable; "Thus" is not a weekday form. zh NUMBER_WORD keeps 十分 (very, when not followed by 钟) and 零食.
 * Fix round 1: US "meter(s)" is not a unit (a glucose meter); 一成 is a percentage except in 一成不变 (Traditional 一成不變).
 */
const EN_UNITS_DIGIT_WORD = "one|two|three|four|five|six|seven|eight|nine";
const R3_RULE_TABLE: ReadonlyArray<readonly [ShellLexicalViolation, RegExp]> = [
  ["NUMBER_WORD", new RegExp(String.raw`\b(?:zero|noughts?|nil|${EN_UNITS_DIGIT_WORD}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]?(?:${EN_UNITS_DIGIT_WORD}))?|hundreds?|thousands?|millions?|billions?|dozens?|scores?|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth)s?|once|twice|thrice|double|triple|quadruple|half|halves|quarters?|a\s+(?:hundred|thousand|couple|pair|dozen))\b`, "i")],
  ["NUMBER_WORD", /十(?!分(?!钟))|廿|卅|百|千|万|亿|两|零(?!食)|〇|[一二三四五六七八九]{2,}|[二三四五六七八九](?:成|倍|点|半)|一半|半数|过半|大半|半个|半天|半年|半月|半小时|[〇零一二三四五六七八九十两廿卅百千万亿](?:餐|顿|杯|碗|片|粒|颗|支|瓶|包|小时|分钟|秒|星期|礼拜|号|日|倍)|[壹贰叁肆伍陆柒捌玖拾佰仟]/],
  ["PERCENT", /\b(?:percent(?:ages?|iles?)?|per\s*cent|pct)\b|百分之|百分比|百分点|个百分点|几成|[二三四五六七八九]成|一成(?!不[变變])/i],
  ["UNIT", /\b(?:milligrams?|micrograms?|grams?|kilograms?|kilos?|millimoles?|millimol|moles?|mol|litres?|liters?|millilitres?|milliliters?|decilitres?|deciliters?|dl|pounds?|ounces?|oz|stones?|centimetres?|centimeters?|metres?|millimetres?|millimeters?|mmhg|inch(?:es)?|calories?|kcal|units?|tablets?|capsules?|puffs?|doses?|dosages?|minutes?|mins?|hours?|hrs?|seconds?)\b|毫摩尔|摩尔|每升|毫克|微克|公斤|千克|公克|毫升|厘米|公分|公尺|毫米|毫米汞柱|磅|盎司|卡路里|大卡|千卡|单位|片剂|胶囊|剂量/i],
  ["DATE_OR_TIME", /\b(?:days?|weeks?|weekends?|fortnights?|months?|years?|daily|weekly|fortnightly|monthly|yearly|annual(?:ly)?|hourly|mornings?|afternoons?|evenings?|nights?|overnight|noon|midday|midnight|dawn|dusk|(?:past|last|this|next|coming)\s+(?:week|weekend|month|year|night|morning|afternoon|evening)|the\s+other\s+day|recently)\b|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜|凌晨|每天|每日|每周|每月|每年|天天|本月|本年|前几天|前些天|这几天|近几天|上星期|下星期|这星期|周末/i],
  ["DATE_OR_TIME", /\b(?:May|March|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b/],
];
const R3_RULES: ReadonlyArray<readonly [ShellLexicalViolation, RegExp]> = Object.freeze(R3_RULE_TABLE.map(([violation, pattern]) => Object.freeze([violation, Object.freeze(pattern)] as const)));
/** Rules r3: the rules the en pair-joined candidates are tested against (r1/r2 and r3 entries alike), plus DIRECTIVE. */
const PAIR_JOINED_RULES: ReadonlySet<ShellLexicalViolation> = new Set<ShellLexicalViolation>(["NUMBER_WORD", "PERCENT", "UNIT", "DATE_OR_TIME", "COMPARATIVE_DIRECTION", "MEASURE_NAME"]);
/** Every S5 word-list pattern (r1/r2 then r3), exported read-only for the Traditional-coverage test. */
export const SHELL_LEXICAL_RULES: ReadonlyArray<readonly [ShellLexicalViolation, RegExp]> = Object.freeze([...RULES, ...R3_RULES]);

/**
 * S5 over one shell text with its tokens removed: format characters and the locale allowlist on the text itself; every
 * rule and the locale allowlist on its scan copy; the word-list rules on the joined zh copy too. Rules r7 fix round 2: the optional
 * `tokenText` (the same field with its slot tokens) is read only by the r7 token/digit guard; every other rule ignores it.
 */
export function shellLexicalViolations(text: string, locale: AiLocale, tokenText?: string): ShellLexicalViolation[] {
  const copies = shellScanCopies(text, locale);
  const scan = copies[0]!;
  const base = baseScanCopies(copies, locale);
  // Rules r7 fix round 2: the token-bearing scan copies (when the caller passes the field text with its tokens) for the guard.
  const tokenCopies = tokenText === undefined ? [] : shellScanCopies(tokenText, locale);
  // Rules r7 fix rounds 1–2: en-SG also reads the split-rejoined copies (r3 join limits), only when nothing else matched.
  const r7Fallback = () => tokenCopies.some((copy) => R7_TOKEN_GUARD.test(copy)) || (locale === "en-SG" && (splitDirection(copies, R7_DIRECTION_GLOBAL) || splitDirection(tokenCopies, R7_TOKEN_GUARD_GLOBAL)));
  const found = RULES.filter(([violation, pattern]) => (WORD_LIST_RULES.has(violation) ? copies : base).some((copy) => ruleMatches(violation, pattern, copy)) || (violation === "COMPARATIVE_DIRECTION" && r7Fallback())).map(([violation]) => violation);
  // Rules r3: the r3 entries on every copy, then (en-SG) every pair-joined candidate against the r1/r2 and r3 entries.
  const joined = locale === "en-SG" ? pairJoinedCandidates(copies) : [];
  const add = (violation: ShellLexicalViolation) => {
    if (!found.includes(violation)) found.push(violation);
  };
  for (const [violation, pattern] of R3_RULES) if (copies.some((copy) => pattern.test(copy))) add(violation);
  for (const [violation, pattern] of SHELL_LEXICAL_RULES) if (PAIR_JOINED_RULES.has(violation) && joined.some((candidate) => pattern.test(candidate))) add(violation);
  if (!found.includes("NUMBER_WORD") && copies.some((copy) => spelledCounts(copy).length > 0)) found.push("NUMBER_WORD");
  if (FORMAT_CHARACTER.test(text)) found.push("FORMAT_CHARACTER");
  if (originalOutsideAllowlist(text, locale) || outsideAllowlist(scan, locale) || COMBINING_MARK.test(scan)) found.push("DISALLOWED_CHARACTER");
  return found;
}

const DIRECTIVE: readonly RegExp[] = Object.freeze([
  /\b(?:should|must|ought\s+to|needs?\s+to|have\s+to|has\s+to|try(?:ing)?\s+to|make\s+sure|remember\s+to|be\s+sure\s+to|please|recommend\w*|suggest\w*|consider(?:ing)?|advis\w*|don't\s+forget)\b/i,
  /应该|应当|必须|需要|请|建议|务必|记得|最好|一定要|不妨|可以考虑/,
].map((pattern) => Object.freeze(pattern)));
/**
 * Rules r3 directive (advice) entries, additive to DIRECTIVE. zh 注意 counts after 请/要/应/需 or at the start of a
 * sentence (start of text or after 。！？!?.); fix round 1 adds 须 (so 必须注意 too); "remember" and "be sure" count with or
 * without "to". Rules r9: 留意 counts unless it directly follows 所 (the 您所留意的 relative clause).
 */
const R3_DIRECTIVE: readonly RegExp[] = Object.freeze([
  /\b(?:please|pls|plz|should|shouldn'?t|ought|must|mustn'?t|needs?\s+to|ha(?:ve|s)\s+to|had\s+better|kindly|let's|recommend\w*|suggest\w*|advis\w*|encourage\w*|urge\w*|consider\w*|try(?:ing)?\s+to|make\s+sure|be\s+sure|remember|don'?t\s+forget|do\s+not\s+forget|it\s+is\s+(?:best|better|important|advisable|wise|essential)\s+to|it's\s+(?:best|better|important)\s+to|you\s+(?:may|might|could)\s+(?:want|wish|like)\s+to|you\s+can\s+try|be\s+careful|keep\s+(?:an\s+eye|track)|check\s+with|talk\s+to|speak\s+(?:to|with)|ask\s+your|avoid\w*)\b/i,
  /千万|记住|别忘|不要|尽量|应当|(?<!所)留意|(?:请|要|应|需|须)注意|(?:^|[。！？!?.])\s*注意|记得|不妨|可以考虑|要记得|要留意/,
].map((pattern) => Object.freeze(pattern)));
/**
 * Rules r10 (owner decision 2026-10-09: no advice and no implied urgency; no assigned importance or noteworthiness), additive to the r1
 * and r3 directive entries and read by S6 exactly as they are. Context-checked phrases, never a bare keyword:
 * en attention — "needs/deserves/warrants/requires/merits/calls for (your/close …) attention", "to/for your attention", "attention is
 *   needed", and "pay/paying (close …) attention" unless it describes the person ("you paid attention to", "you have been paying
 *   attention to");
 * en watching — "watch"/"monitor" opening a sentence, "watch/monitor/track/follow/check/observe … closely", "closely watch …", "keep
 *   watching/monitoring/…", "keep a (close) watch", "watch out", "look out for", "on the lookout";
 * en worth — "worth watching/monitoring/noting/mentioning/a look/attention/…", "worthy of note/attention/concern";
 * en concern — "concerning" as an adjective: after a/an or an intensifier; after a copula unless a preposition object follows (a
 *   determiner, a pronoun or a slot token: in the token-separated reading a token is blank space, so "is concerning {{S1}}." reads as
 *   the preposition); "the/this … concerning pattern/trend/…"; "concerning." directly at a clause end; "concerningly", "of (some …)
 *   concern", "worrisome", "troubling". "notes concerning …" stays accepted;
 * en importance — important(ly), notable/notably, noteworthy, importance, "of (particular) note", unless the person did the marking
 *   ("you marked/flagged/consider(ed)/find/found … as important");
 * zh — 值得 + an attention, notice, concern or mention verb (值得关注, 值得注意, 值得一提 …); 留心/留神 unless after 所; 注意一下 and
 *   its siblings; bare 您 + an attention verb unless 到/的/过 follows (您注意一下 rejects, 您关注的 and 您注意到的 pass); 您 + a modal +
 *   an attention verb always (您需关注的, 您要关注的); a modal + 关注/留心/留神/重视/警惕 anywhere (应关注, 须关注, 需关注, 多关注, 可以多关注;
 *   r10 tightened before commit, coordinator ruling: the zh form of "needs your attention") and 要特别注意 / 要多加注意; an
 *   attention verb opening a sentence; 密切 + a watching verb; 引人注目, 令人担忧 and their siblings; 重要 unless the person is the one
 *   who regards it so (您认为重要的, 您所觉得重要的).
 */
const R10_EN_PERSON_MARKED = String.raw`(?<!\byou(?:\s+(?:have|had)|'ve|'d)?\s+(?:marked|flagged|starred|labell?ed|tagged|find|found|feel|felt|called|noted)\s+(?:(?:it|them|this|these|those)\s+)?(?:as\s+)?)`;
const R10_DIRECTIVE: readonly RegExp[] = Object.freeze([
  // en attention.
  /\b(?:needs?|needed|needing|requir(?:es?|ed|ing)|deserv(?:es?|ed|ing)|warrant(?:s|ed|ing)?|merit(?:s|ed|ing)?|worth|worthy\s+of|call(?:s|ed|ing)?\s+for)\s+(?:(?:your|some|close|closer|careful|special|particular|extra|more|further|immediate|prompt|real|any|a\s+little|a\s+bit\s+of)\s+){0,2}attention\b|\b(?:to|for)\s+your\s+(?:\w+\s+)?attention\b|\battention[\s-]+(?:worthy|needed|required|warranted)\b|\battention\s+(?:is|was|may\s+be|might\s+be|could\s+be)\s+(?:needed|required|warranted|advised|called\s+for)\b/i,
  /(?<!\byou(?:\s+(?:have|had)\s+been|'ve\s+been|'d\s+been|\s+are|'re|\s+were)\s+)\bpa(?:y|ys|ying)\s+(?:(?:close|closer|careful|special|particular|extra|more|some|full)\s+)?attention\b/i,
  // en watching.
  /(?:^|[.!?:;]\s*)(?:watch|monitor)\b|\b(?:watch\w*|monitor\w*|track\w*|follow\w*|check\w*|observ\w*)\b[^.!?]{0,40}?\bclosely\b|\bclosely\s+(?:watch|monitor|track|follow|check|observ)\w*|\bkeep\s+(?:on\s+)?(?:watching|monitoring|checking|tracking|following|observing)\b|\bkeep\s+a\s+(?:close\s+)?watch\b|\bwatch\s+out\b|\blook\s+out\s+for\b|\bon\s+the\s+look-?out\b/i,
  // en worth.
  /\bworth\s+(?:(?:a|an|the|some|your|special|particular|closer|close|second|careful|further|another|quick|more|extra)\s+){0,2}(?:watching|monitoring|tracking|following|noting|noticing|mentioning|highlighting|flagging|checking|looking|look|attention|keeping|concern|remembering|observing|pointing\s+out|a\s+mention)\b|\bworthy\s+of\s+(?:\w+\s+)?(?:note|notice|attention|concern|mention)\b/i,
  // en concern.
  /\b(?:a|an|quite|rather|somewhat|very|more|most|less|slightly|particularly|especially|potentially|possibly|really|so|too|bit|little)\s+concerning\b|\b(?:is|are|was|were|be|been|being|looks?|looked|seems?|seemed|appears?|appeared|remains?|find|finds|found)\s+concerning\b(?!\s+(?:the|your|you|a|an|each|every|all|its|their|this|that|these|those|how|what|whether|which|when|where)\b|\s+[^\sA-Za-z]|\s*$)|\b(?:the|this|that|these|those)\s+concerning\s+(?:patterns?|trends?|readings?|results?|signs?|changes?|levels?|values?|pictures?|entr(?:y|ies)|findings?|numbers?|records?)\b|\bconcerning[.!?;]|\bconcerningly\b|\bof\s+(?:(?:some|real|particular|potential|possible|special|great|serious|slight|mild|little|any|no)\s+)?concern\b|\bworrisome\b|\btroubling\b/i,
  // en importance.
  new RegExp(String.raw`${R10_EN_PERSON_MARKED}\b(?:important(?:ly)?|importance|notabl[ey]|noteworthy)\b|\bof\s+(?:(?:particular|special|some|real)\s+)?note\b`, "i"),
  // zh.
  /值得(?:特别|格外|多加|加以|进一步|再|去|您|我们|大家|好好|仔细){0,2}(?:关注|注意|留意|留心|留神|重视|警惕|注目|一提|提及|一看|当心|小心|担心|担忧|关心|观察|追踪|跟踪|跟进|监测)|(?<!所)(?:留心|留神)|(?:注意|留意|留心|留神|关注)一下|您(?:注意|留心|留神|关注|当心|小心|警惕|重视)(?![到的过過])|您(?:要|多|多加|好好|再|得|可以|可|不妨|最好|务必|一定|需|应|应该)(?:注意|留心|留神|关注|当心|小心|警惕|重视)|(?:要|应|需|须|得|多|多加|可以多)(?:关注|留心|留神|重视|警惕)|要(?:特别|多加)注意|(?:^|[。！？!?.；;：:])\s*(?:关注|当心|小心|警惕|重视|留神|留心|密切)(?![到的过過])|密切(?:关注|注意|留意|留心|观察|监测|跟进|追踪|跟踪)|引人(?:注目|关注|注意|担忧|担心)|(?:令|让)人(?:担忧|担心|不安|忧虑|关注|注目)|引起(?:您的?)?(?:关注|注意|重视|警惕)|(?<!您所?(?:[认認][为為爲]|[觉覺]得|[视視][为為爲]|[标標][记記]?[为為爲]))重要/,
].map((pattern) => Object.freeze(pattern)));
/**
 * Rules r11 (owner decision 2026-10-11, salience option (a): model wording must not assign importance or noteworthiness to the person's
 * readings or patterns), additive to the r1, r3 and r10 directive entries and read by S6 exactly as they are. Context-checked phrases,
 * never a bare keyword:
 * en salience — significant(ly), significance, crucial(ly) unless the person did the marking (the r10 R10_EN_PERSON_MARKED check: "the
 *   items you marked as significant"); key attributive ("the key items", "key {{S1}}", "the ‘key’ items", "the key to …") unless a
 *   legend or typing reading follows (the key below/for/of …, key in; keyed in, keywords and low-key stay open), and key predicative
 *   after a copula ("is key", "remains very key");
 * en look closely — "look (more …) closely/carefully", "look at … closely" at a clause end, "closely look";
 * en notice — "notice" opening a sentence (optionally after do/just/now/also/simply/first/then/and; not "notice of" or "notice
 *   board"), after a comma before an object (", notice how/the/…"), and "you may/might/will/would/could/can/should/'ll notice";
 *   "the items you noticed" and a mid-sentence noun "notice" stay open;
 * en keep in mind — "keep/bear … in mind" unless it describes the person ("the items you keep in mind", "you have been keeping … in
 *   mind"); "kept in mind" is past description and stays open;
 * en to watch — "to watch/monitor/notice" (also "to keep watching", "to closely watch") unless the person chose it ("the readings you
 *   chose to watch", "you wanted to monitor");
 * zh — 重点 and 关键 unless the person is the one who regards it so (the r10 您认为/您觉得/您视为/您标为 check), 关键词/关键字 stay open; 显著
 *   (Traditional 重點, 關鍵, 顯著 through the T→S copy; 顯著 is read on the copy itself because 著 maps to 着).
 */
const R11_ZH_PERSON_REGARDED = String.raw`(?<!您所?(?:[认認][为為爲]|[觉覺]得|[视視][为為爲]|[标標][记記]?[为為爲]))`;
const R11_EN_PERSON_CHOSE = String.raw`(?<!\byou(?:\s+(?:have|had)|'ve|'d)?\s+(?:\w+\s+)?(?:chose|choose|chosen|choosing|decided|decide|want|wanted|wish|wished|like|liked|asked|plan|planned|start|started|continue|continued|prefer|preferred|tend|tended|used|tried|went|came)\s+)`;
const R11_DIRECTIVE: readonly RegExp[] = Object.freeze([
  // en salience.
  new RegExp(String.raw`${R10_EN_PERSON_MARKED}\b(?:significant(?:ly)?|significance|crucial(?:ly)?)\b`, "i"),
  new RegExp(String.raw`${R10_EN_PERSON_MARKED}(?<!\blow[\s-]?)\bkey\b['*]*\s+(?!(?:in|into|for|of|on|below|above|here|there|and|or|with|that|which|shows?|showed|explains?|lists?|reads?)\b)(?=[a-z])|\b(?:is|are|was|were|be|been|being|remains?|remained|seems?|seemed|looks?|looked|appears?|appeared|feels?|felt|stays?|stayed|becomes?|became|'s|'re)\s+(?:(?:especially|particularly|really|very|most|so|truly|absolutely|quite|also|still|now|equally)\s+)?key\b`, "i"),
  // en look closely.
  /\blook(?:s|ed|ing)?\s+(?:(?:more|very|really|extra|especially|particularly|a\s+bit|a\s+little)\s+)?(?:closely|carefully)\b|\blook(?:s|ed|ing)?\s+at\b[^.!?,;:]{0,40}?\bclosely\s*(?:[.!?,;:]|$)|\b(?:closely|carefully)\s+look(?:s|ed|ing)?\b/i,
  // en notice.
  /(?:^|[.!?:;]\s*)(?:(?:do|just|now|also|simply|first|then|and)\s+)?notice\b(?!\s+(?:of|boards?)\b)|,\s*(?:and\s+)?notice\s+(?:how|that|what|whether|the|this|these|those|it|them|any|your)\b|\byou(?:'ll|'d|\s+(?:may|might|will|would|could|can|should|shall))\s+(?:(?:also|now|probably|likely|then|soon|quickly|easily|already|immediately|clearly|readily)\s+)?notice\b/i,
  // en keep in mind.
  /(?<!\byou(?:\s+(?:have|had)\s+been|'ve\s+been|'d\s+been|\s+are|'re|\s+were)?\s+)\b(?:keep|keeps|keeping|bear|bears|bearing)\b[^.!?]{0,40}?\bin\s+mind\b/i,
  // en to watch.
  new RegExp(String.raw`${R11_EN_PERSON_CHOSE}\bto\s+(?:(?:keep|closely|carefully)\s+)?(?:watch|monitor|notice)\b`, "i"),
  // zh.
  new RegExp(String.raw`${R11_ZH_PERSON_REGARDED}(?:重点|关键(?![词詞字]))|[显顯]著`),
].map((pattern) => Object.freeze(pattern)));
/**
 * Rules r12 (owner decision 2026-10-11, policy-led prompt 11b.20: describe, never evaluate), additive to the r1, r3, r10 and r11 directive
 * entries. The en entries are read by S6 exactly as those entries (every scan copy, the en pair/triple joins, the token-separated copy,
 * stand-in provenance); the zh entries (fix round 1) read the clause-preserving copies only (SHELL_CLAUSE_DIRECTIVE_PATTERNS below), with
 * the same token-separated reading and provenance. The stand-in "the item" / 该项 counts as a data holder (F1). Four claim shapes, each a
 * HOLDER and an ASSERTION in the same clause (no clause punctuation between them), never a bare keyword:
 * F1 judgement of the person's data — a data noun (readings, results, levels, numbers, values, sugar, figures, items, entries, data,
 *   these, they, it, this, everything, all of this; 读数, 结果, 数值, 记录, 血糖, 数据, 这些, 它, 内容, 项目), optionally followed by a short
 *   relative clause with the person as subject ("the readings you recorded"), with an evaluative, state or salience predicate after a
 *   linking verb, also progressive or perfect (look/are/seem/are looking/have been good, fine, okay, great, healthy, stable, steady,
 *   under control, well controlled, on track, in range, improving, noticeable, (in)significant …; stand out, matter; 很好, 不错, 理想,
 *   正常, 稳定, 控制得好, 良好, 令人满意, 突出, 凸显) or that adjective before the noun, directly or with 的 ("noticeable readings",
 *   突出的记录; never the adverbial 稳定地 + a verb), and 是/为 … 要点 (要点开 and 要点明 are 要 + 点开/点明 and stay open). The r10
 *   person-marked ("the readings you marked as noticeable") and r11 person-regarded (您认为突出的) checks keep the person's own judgement
 *   open; "it is fine to …" is not a judgement.
 * F2 benefit or cause — an ACTIVITY OR TREATMENT holder only (walk(s), walking and other activity gerunds, exercise, activity, diet,
 *   food, meal(s), medicine, medication, insulin, pen, treatment; 散步, 运动, 锻炼, 饮食, 药, 胰岛素, 治疗) with a benefit or causal verb
 *   (help, benefit, good for, improve, work, lower, reduce, keep … down/in check, pay off, make a difference; 有助, 有帮助, 有益, 改善,
 *   降低, 有效, 帮助, 效果很好 …), with at most one -ly adverb between ("walking regularly helps"). Fix round 1: a summary, this view or a
 *   bare demonstrative (this, it, 这, 这样) or the slot stand-in is not an activity, so "This may help you get ready …" and 这样可以帮助您
 *   做好准备 stay open; "help(s) you prepare/review/bring …" and 有助于您准备/整理/回顾 … stay open after an activity too; "how it works"
 *   is not a claim. Fix round 2 adds two holder-independent F2 shapes: a benefit verb whose object or complement is a health, body or
 *   reading target ("helps your health", "good for your health", "helps you control your levels"; 对您的健康有帮助, 有助于控制…血糖/身体),
 *   and an intransitive "is helping"/"is working" closing a clause with a data, slot or demonstrative subject ("{{S1}} is helping.";
 *   该项/它 + 有帮助, 这样很有帮助。).
 * F3 completed-state claim — a perfect or passive saved/sent/shared/reviewed/received/updated/submitted construction ("have been
 *   saved", "is now sent"), the active perfect with the app, JagaOn, "we", "I" or a third party as subject ("we have saved", "JagaOn has
 *   updated"), or a recipient who now has the notes ("your care team has these"); zh 已(经) + 保存/发送/提交/审核/分享/更新/收到/发给 …
 *   and 保存好了. The person's own action stays open ("the readings you recorded", "you have saved", 您已记录的, 您记录下来的; zh: 您 with
 *   up to two time or manner adverbs before 已 — 您之前已经保存的, 您刚才已更新的 — is the person's action; 您的记录已保存 is not).
 * F4 attributed feeling — the person with an emotion or inner state the model cannot ground ("you may be feeling worried", "you seem
 *   tired", "understandable to feel"; 您(可能)(会)感到, 您(可能)觉得 + 累/疲惫/担心 …, 您 + a modal + an emotion (您一定很担心), 您辛苦了,
 *   您看起来 + an emotion). 您认为重要的 and 您所觉得重要的 (r10) stay open: 觉得 counts only with an emotion word, and the bare emotion only
 *   after a modal.
 * Traditional forms read through the T→S copy with the additive R12_TRADITIONAL_TABLE rows.
 */
const R12_EN_DEGREE = String.raw`(?:all|both|very|really|quite|pretty|so|truly|fairly|reasonably|mostly|generally|overall|still|now|clearly|rather|particularly|especially|nicely|already|also|definitely|certainly)`;
// Fix round 1: "everything", "all of this/these/them" and "all this" are data holders too ("everything looks good here").
const R12_EN_DATA_HOLDER = String.raw`\b(?:readings?|results?|levels?|numbers?|values?|sugars?|figures?|items?|entries|data|these|they|it|this|everything|all\s+(?:of\s+)?(?:this|these|them))`;
// Fix round 1: a short relative clause with the person as subject may sit between the holder and the predicate ("the readings you recorded
// look good"); the person's own marking ("the readings you marked as noticeable") is still read by R10_EN_PERSON_MARKED before the adjective.
const R12_EN_HOLDER_RELATIVE = String.raw`(?:\s+(?:that\s+|which\s+)?you(?:\s+have|'ve)?\s+[a-z]+(?:\s+(?:down|in|up|out))?)?`;
// Fix round 1: progressive and perfect linking forms ("are looking", "have been", "has stayed").
const R12_EN_LINK = String.raw`(?:'s|'re|'ve\s+been|\s+(?:(?:is|are|was|were)\s+(?:looking|seeming|staying|remaining|getting)|(?:has|have|had)\s+(?:been(?:\s+(?:looking|staying|remaining))?|stayed|remained|looked|seemed)|is|are|was|were|be|been|being|look|looks|looked|looking|seem|seems|seemed|appear|appears|appeared|remain|remains|remained|stay|stays|stayed|sound|sounds))`;
const R12_EN_EVALUATIVE = String.raw`(?:good|fine|ok|okay|alright|all\s+right|great|healthy|stable|steady|excellent|ideal|perfect|nice|lovely|reassuring|positive|encouraging|promising|impressive|under\s+control|(?:well|nicely|tightly)[\s-]+(?:controlled|managed|kept|maintained|balanced)|(?:on|in)\s+track|in\s+(?:range|target|check|order|line)|on\s+target|within\s+(?:range|target)|improving|noticeable|(?:in)?significant|remarkable|meaningful|striking|telling)\b`;
const R12_EN_EMOTION = String.raw`(?:(?:a\s+(?:bit|little)|quite|rather|somewhat|very|so|really|too|a\s+lot)\s+)?(?:worried|anxious|tired|exhausted|stressed|overwhelmed|frustrated|sad|upset|concerned|nervous|scared|afraid|frightened|discouraged|disappointed|unwell|relieved|happy|proud|hopeful|reassured|calm|confident|uneasy|uncertain|unsure|alone|lonely|drained|weary|burdened|pressured|guilty|fatigued|worn\s+out|fed\s+up|annoyed|better|good|great|fine|okay|ok)\b`;
// Fix round 1 (F2 holder narrowed): only an activity or treatment holds a benefit claim. "this", "it" and the slot stand-in are no longer
// F2 holders, so "This may help you get ready …" (the summary helping the person) stays open; activity gerunds count ("walking regularly
// helps").
const R12_EN_ACTIVITY_HOLDER = String.raw`(?<!\bhow\s+)\b(?:walks?|walking|exercis(?:e|es|ing)|workouts?|activit(?:y|ies)|diet|food|foods|meals?|eating(?:\s+well)?|medicines?|medications?|insulin|pens?|treatments?|cycling|swimming|running|jogging|stretching|gardening|dancing|resting|sleeping|(?:staying|keeping)\s+active)`;
// F3 subjects that are not the person (fix round 1: the active perfect, "we have saved", "the app has updated").
const R12_EN_OTHER_SUBJECT = String.raw`\b(?:we|i|jagaon|the\s+app|this\s+app|the\s+system|the\s+application|(?:your\s+|the\s+)?(?:care\s+team|team|doctors?|nurses?|clinicians?|clinic|pharmacists?|specialists?|physicians?)|someone|somebody)`;
const R12_EN_DONE = String.raw`(?:saved|sent|shared|reviewed|received|updated|submitted|recorded|stored|forwarded|delivered|uploaded|synced|backed\s+up|filed|logged|passed\s+on|checked|approved|seen)`;
const R12_DIRECTIVE: readonly RegExp[] = Object.freeze([
  // F1 en: data holder, then a linking verb and an evaluative or state adjective ("these results look good", "your levels are well controlled").
  new RegExp(String.raw`${R12_EN_DATA_HOLDER}${R12_EN_HOLDER_RELATIVE}(?:\s+(?:that|which))?(?:\s+${R12_EN_DEGREE}){0,2}${R12_EN_LINK}(?:\s+${R12_EN_DEGREE}){0,2}\s+${R10_EN_PERSON_MARKED}${R12_EN_EVALUATIVE}(?!\s+(?:to|for\s+(?:you|us)\s+to)\b)`, "i"),
  // F1 en: data holder, then a salience verb ("the readings that stand out", "the readings that matter most").
  new RegExp(String.raw`${R12_EN_DATA_HOLDER}(?:\s+(?:that|which))?(?:\s+${R12_EN_DEGREE}){0,2}\s+(?:(?:stand|stands|standing|stood|stick|sticks|sticking|stuck|jump|jumps|jumped|jumping)[\s-]+out|matter(?:s|ed|ing)?)\b`, "i"),
  // F1 en: the evaluative adjective before the data noun ("noticeable readings", "insignificant readings"), unless the person marked it.
  new RegExp(String.raw`${R10_EN_PERSON_MARKED}\b(?:noticeable|(?:in)?significant|standout|stand-out|outstanding|remarkable|striking|good|great|excellent|healthy|stable|steady|ideal|perfect|reassuring|encouraging|promising|impressive|(?:well|nicely)[\s-](?:controlled|managed))['*]*\s+(?:the\s+)?(?:readings?|results?|levels?|numbers?|values?|sugars?|figures?|items?|entries|data)\b`, "i"),
  // F2 en: activity or treatment holder, then a benefit or causal verb ("your walks are helping your health", "your medicine is working",
  // "walking regularly helps", "your diet has made a difference").
  new RegExp(String.raw`${R12_EN_ACTIVITY_HOLDER}(?:\s+(?:is|are|was|were|has|have|had|been|be|will|would|may|might|can|could|should|seems?\s+to|appears?\s+to|tends?\s+to|really|truly|clearly|already|also|definitely|certainly|actually|still|now|all|both)){0,3}(?:\s+[a-z]+ly)?\s+(?:help(?:s|ed|ing)?(?!\s+(?:you\s+)?(?:to\s+)?(?:prepare|see|review|bring|find|remember|recall|read|organi[sz]e|gather|collect|look|share|ask|plan|talk|discuss|note|list|go\s+through|keep\s+track|track|follow\s+along)\b)|benefit(?:s|ed|ing)?|(?:good|great|helpful|beneficial|useful|effective)\s+for|helpful|beneficial|effective|improv\w*|work(?:s|ed|ing)?|lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)|pay(?:s|ing)?\s+off|paid\s+off|(?:make|makes|made|making)\s+(?:a\s+)?(?:(?:real|big|great|huge|positive|good)\s+)?difference|keep(?:s|ing)?\s+(?:\w+\s+){0,2}(?:down|in\s+check|under\s+control|steady|stable))\b`, "i"),
  // F2 en (fix round 2, holder-independent): a benefit verb whose object or complement is a health, body or reading target ("it helps your
  // health", "this helps your sugar", "this is good for your health", "helps you control your levels"); "help you get ready / understand /
  // revisit …" has no such target and stays open.
  new RegExp(String.raw`\b(?:help(?:s|ed|ing)?|benefit(?:s|ed|ing)?|improv(?:e|es|ed|ing)|good\s+for|great\s+for|helpful\s+for|beneficial\s+for|useful\s+for|work(?:s|ed|ing)?\s+(?:for|on))\s+(?:(?:you\s+)?(?:to\s+)?(?:keep|control|manage|lower|reduce|improve|stabili[sz]e|balance|steady)\s+)?(?:(?:your|the|my|their)\s+)?(?:(?:overall|general|blood)\s+)?(?:health|sugars?|glucose|levels?|readings?|numbers?|body|condition|control|weight|pressure|well-?being)\b`, "i"),
  // F2 en (fix round 2): intransitive "is helping" / "is working" (or "helps" / "works") closing a clause, with a data, slot or demonstrative
  // subject ("{{S1}} is helping.", "it is working."); "how it works" stays open.
  /(?<!\bhow\s+)\b(?:it|this|that|these|they|items?|readings?|results?|numbers?|levels?|everything)\s+(?:(?:is|are|was|were|'s|'re)\s+(?:(?:really|clearly|definitely|already|also|still|now)\s+)?(?:helping|working)|(?:(?:really|clearly|definitely|already|also)\s+)?(?:helps|works))\s*(?:[.!?;:,]|$)/i,
  // F3 en: perfect or passive completed-state claims, a recipient who now has the notes, and (fix round 1) the active perfect with the
  // app, "we" or a third party as subject ("we have saved", "JagaOn has updated"); the person as subject ("you have saved") stays open.
  new RegExp(String.raw`\b(?:has|have|had|'s|'ve)\s+(?:(?:now|already|just|also|all|safely|securely|successfully)\s+){0,2}been\s+(?:(?:now|already|just|all|safely|securely|successfully|automatically)\s+){0,2}${R12_EN_DONE}\b|\b(?:is|are|was|were|gets?|got)\s+(?:(?:now|already|just|also|all|safely|securely|successfully|automatically)\s+){0,2}(?:saved|sent|shared|reviewed|received|submitted|stored|forwarded|delivered|uploaded|synced|backed\s+up|updated|passed\s+on)\b|\b(?:care\s+team|team|doctors?|nurses?|clinicians?|clinic|pharmacists?|specialists?|physicians?)\s+(?:(?:now|already|also|will|should|can|may)\s+){0,2}(?:has|have|had|holds?|got|gets?|receives?|received|sees?|saw|see|knows?)\s+(?:(?:all|both)\s+)?(?:these|this|them|it|the|your|a\s+copy)\b|${R12_EN_OTHER_SUBJECT}(?:'ve|'s|\s+(?:has|have|had))\s+(?:(?:now|already|just|also|all|safely|securely|successfully|automatically)\s+){0,2}(?:${R12_EN_DONE}|changed|added)\b`, "i"),
  // F4 en: the person with an emotion or inner state the model cannot ground.
  new RegExp(String.raw`\byou(?:'re|'ll|'d|\s+(?:are|were|will|would|may|might|could|must|probably|likely|possibly|perhaps|also|still|now|sometimes|often|well))*\s+(?:be\s+)?(?:feel|feels|feeling)\s+(?:like\s+)?(?:${R12_EN_EMOTION}|(?:(?:a\s+(?:bit|little)|quite|rather|very|so|really)\s+)?(?:down|low)\b)|\b(?:understandabl[ey]|natural|normal|common|only\s+human)\s+(?:for\s+you\s+)?to\s+(?:feel|be\s+feeling)\b|\b(?:okay|ok|fine|alright)\s+(?:for\s+you\s+)?to\s+(?:feel|be\s+feeling|be)\s+${R12_EN_EMOTION}|\byou(?:'re|\s+are)?\s+(?:seem|seems|seemed|appear|appears|appeared|look|looks|looked|sound|sounds|sounded|must\s+be|may\s+be|might\s+be|could\s+be|are\s+probably|'re\s+probably|are\s+likely)(?:\s+to\s+be)?\s+${R12_EN_EMOTION}`, "i"),
].map((pattern) => Object.freeze(pattern)));
/** Every S6 directive pattern (r1/r2, r3 with the r9 refinement, r10, r11, then the r12 en entries), exported read-only for the Traditional-coverage test. */
export const SHELL_DIRECTIVE_PATTERNS: readonly RegExp[] = Object.freeze([...DIRECTIVE, ...R3_DIRECTIVE, ...R10_DIRECTIVE, ...R11_DIRECTIVE, ...R12_DIRECTIVE]);

/**
 * Rules r12 fix round 1 (zh "same clause"): the r12 zh frames read CLAUSE-PRESERVING copies (shellClauseScanTexts), never the joined
 * copies, so a holder ending one clause never pairs with an assertion opening the next (这里呈现{{S1}}，可以帮助您回想). A clause boundary is
 * ，。！？；：、 (and their ASCII forms) or a line break; the gap between a holder and its assertion may not cross one. Every other
 * punctuation, symbol or whitespace run between two ideographs is removed in that copy (clauseJoinedZhScanText), so a split INSIDE a listed
 * word by a non-boundary mark (突～出, 保（存）) still reads as the word. Fix round 3 (owner option (a)): a single 、 or ， is removed ONLY
 * when it sits strictly inside one word of the closed, reviewed R12_ZH_SPLIT_CUE_WORDS list (已、经保存, 突、出, 稳，定, 感、到, 有，帮助),
 * so the two halves rebuild exactly that cue word; every other clause mark — including one after a complete word such as 整理，想… or
 * 都有，帮助… — keeps its boundary. The inherited joined copies and every other rule are unchanged.
 */
const CLAUSE_JOIN_SEPARATOR = (): RegExp => /(?<=[\u3400-\u9FFF\uF900-\uFAFF])[^\u3400-\u9FFF\uF900-\uFAFFA-Za-z0-9_，。！？；：、,.!?;:\n\r]+(?=[\u3400-\u9FFF\uF900-\uFAFF])/g;
/** The zh scan copy with every non-boundary separator run between two ideographs removed, repeated until stable; clause marks are kept. */
export function clauseJoinedZhScanText(scan: string): string {
  let current = scan;
  for (let next = current.replace(CLAUSE_JOIN_SEPARATOR(), ""); next !== current; next = current.replace(CLAUSE_JOIN_SEPARATOR(), "")) current = next;
  return current;
}
const R12_ZH_DATA_HOLDER = "(?:读数|结果|数值|记录|血糖|数据|这些|它们?|该项|内容|项目)";
const R12_ZH_EMOTION = "(?:有些|有点儿?|一些|很|非常|比较|挺|特别|十分|更加?|格外|相当|太)?(?:累|疲惫|疲倦|疲劳|疲乏|担心|担忧|焦虑|紧张|难过|伤心|不舒服|辛苦|开心|高兴|安心|放心|沮丧|失落|压力|烦|害怕|不安|无助|孤单|孤独|困扰|欣慰|满意|轻松|委屈|灰心|气馁|无奈|吃力|心累|自豪|骄傲)";
const R12_ZH_MODAL = "(?:可能|也许|或许|大概|应该|一定|难免|肯定)";
const R12_ZH_CLAUSE_GAP = "[^，。！？；：、,.!?;:\\n\\r]";
/** Fix round 1 (F3 zh): the person's own earlier action — 您 with up to two time or manner adverbs before 已 (您之前已经保存的, 您刚才已更新的). */
const R12_ZH_PERSON_DID = "(?<!您(?:之前|先前|此前|早前|早先|刚才|刚刚|曾经?|一直|都|也|自己){0,2})";
const R12_ZH_CLAUSE_SOURCES: readonly string[] = [
  // F1 zh: data holder then an evaluative, state or salience predicate in the same clause (fix round 1: 良好, 控制良好, 令人满意).
  `${R12_ZH_DATA_HOLDER}${R12_ZH_CLAUSE_GAP}{0,6}?${R11_ZH_PERSON_REGARDED}(?:(?:很|非常|挺|相当|比较|都|全都|还|蛮|真|特别|十分)+(?:好|不错|理想|正常|稳定|平稳|健康)|不错(?!过)|理想|稳定|平稳|控制得(?:很|非常|相当|比较|还|挺)?(?:好|不错|理想|稳定)|(?:都|很|非常|十分)?良好|(?:令|让)人满意|突出|凸显|显眼|醒目)`,
  // F1 zh: the adjective before the noun — directly, or with 的 (fix round 1: never with the adverbial 地, so 稳定地记录 stays open).
  `${R11_ZH_PERSON_REGARDED}(?:(?:比较|很|最|非常|特别|较为|格外|更)?(?:突出|凸显|显眼|醒目|理想|稳定|不错(?!过))|(?:很|非常|挺|比较|特别|十分)好)(?:的${R12_ZH_CLAUSE_GAP}{0,4}?)?${R12_ZH_DATA_HOLDER}`,
  // F1 zh: 是/为 … 要点 (要点开/明/击/选/出 are 要 + a verb and stay open).
  `(?:是|为)(?:${R12_ZH_CLAUSE_GAP}{0,6}?中的)?要点(?![开明击选出])|${R12_ZH_DATA_HOLDER}中?的要点(?![开明击选出])`,
  // F2 zh: activity or treatment holder then a benefit or causal predicate in the same clause (fix round 1: 这 and the slot stand-in are no
  // longer holders; 效果很好); helping the person prepare stays open.
  `(?:散步|走路|步行|运动|锻炼|活动|饮食|食物|膳食|药物|药|胰岛素|治疗)${R12_ZH_CLAUSE_GAP}{0,8}?(?:有助|有帮助|有益|有好处|改善|降低|有效|起作用|见效|奏效|管用|帮助|帮到|效果(?:很|非常|挺|特别|相当|都)?(?:好|不错|明显))(?!于?您?(?:准备|整理|回顾|查看|记住|带上|带去|提问|沟通|讨论|找到))`,
  // F2 zh (fix round 2, holder-independent): a benefit predicate on a health, body or reading target (对您的健康有帮助, 有助于控制血糖), and
  // the slot stand-in or 它 (also 这/这样 closing a clause) as the subject of an intransitive benefit (该项对您有帮助, 这样很有帮助。).
  `对您?的?(?:健康|身体|血糖|读数|指标)${R12_ZH_CLAUSE_GAP}{0,4}?(?:有帮助|有助|有益|有好处|有效|好处)|(?:有助于|有益于|有利于|帮助|改善|促进)您?的?(?:控制|稳定|降低|改善|管理|维持|保持)?(?:您的)?(?:健康|身体|血糖|读数|指标)|(?:该项|它们?)(?:对您)?(?:很|会|也|确实|真的)?(?:有帮助|有益|有好处|起作用|管用|奏效|有效)|这样?(?:很|会|也|确实|真的)?(?:有帮助|起作用|管用|奏效)(?=$|[，。！？；：、,.!?;:])`,
  // F3 zh: 已(经) + a saved/sent/reviewed verb, or 保存好了, unless the person did it; a recipient who now has the notes.
  `${R12_ZH_PERSON_DID}已(?:经)?(?:被|为您|帮您|替您|给您)?(?:保存|发送|发出|提交|审核|审阅|分享|更新|收到|发给|传给|交给|上传|存档|储存|存好|传送|转发|同步|备份)|${R12_ZH_PERSON_DID}(?:保存|存|发送|提交|上传|备份|同步)好了|(?:医生|护理团队|医疗团队|护士|诊所|药剂师)(?:现在|已经|已)?(?:有了|拥有|收到了|看到了|掌握了)`,
  // F4 zh: 您 (+ a modal) + 感到; 您 (+ a modal) + 觉得/感觉 + an emotion; 您 + a modal + an emotion (fix round 1: 您一定很担心, 您可能有些担心);
  // 您辛苦了 (fix round 1); 您看起来 + an emotion; an emotion called understandable.
  `您${R12_ZH_MODAL}?(?:也)?(?:会)?感到|您${R12_ZH_MODAL}?(?:也)?(?:会)?(?:觉得|感觉到?)${R12_ZH_EMOTION}|您${R12_ZH_MODAL}(?:也)?(?:会)?${R12_ZH_EMOTION}|您(?:真的|实在|也)?辛苦了|辛苦您了|您(?:看起来|看上去|似乎|好像|显得)${R12_ZH_EMOTION}|(?:感到|觉得|感觉)${R12_ZH_EMOTION}(?:是|也是|也)?(?:可以理解|难免|很自然|人之常情)|(?:难免|自然)(?:会)?(?:感到|觉得)`,
];
/** The r12 zh clause patterns (read only on the clause-preserving zh copies), exported read-only for the Traditional-coverage test. */
export const SHELL_CLAUSE_DIRECTIVE_PATTERNS: readonly RegExp[] = Object.freeze(R12_ZH_CLAUSE_SOURCES.map((source) => Object.freeze(new RegExp(source))));
/**
 * Rules r12 fix round 1: the clause-preserving texts the r12 zh patterns read for one text — zh-SG: the clause-joined scan copy and its
 * Traditional→Simplified copy, always two entries (so the stand-in and shadow builds stay aligned); en-SG: none (the r12 en entries are
 * in SHELL_DIRECTIVE_PATTERNS, and en copies never join across punctuation).
 */
export function shellClauseScanTexts(text: string, locale: AiLocale): string[] {
  if (locale !== "zh-SG") return [];
  const scan = clauseJoinedZhScanText(foldShellScanText(text, locale));
  return [r12CueWordJoined(scan), r12CueWordJoined(toSimplified(scan))];
}

/**
 * Rules r12 fix round 3 (owner option (a), 2026-10-11): the closed, reviewed list of r12 claim-shape cue words whose in-word clause-mark
 * split (已、经, 突，出) is rebuilt. This is NOT a word ban: the words are rejected only where an r12 claim shape around them already
 * rejects (holder + assertion in one clause); the list only decides which single 、/， is read as a split INSIDE one of these words.
 * Each entry: the cue word, and (optional) characters that must not directly precede it — when they do, its first half is the end of a
 * complete word (都有, 所有, 没有 …; 而已) and the mark after it is a real clause boundary (您的饮食记录都有，帮助您回想).
 * Words whose first character commonly ends another word in ordinary wording (理想/理解 after 整理/管理, 作用 after 工作, 现在 after 呈现,
 * 对您 after 核对, 诊所 after 就诊, 上传 after 以上, …) are deliberately absent.
 */
const R12_ZH_SPLIT_CUE_WORDS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  // F3 completed state.
  ["已经", "而"], ["保存", ""], ["发送", ""], ["提交", ""], ["分享", ""],
  // F1 judgement and salience.
  ["突出", ""], ["凸显", ""], ["稳定", ""], ["平稳", ""], ["良好", ""], ["满意", ""],
  // F2 benefit.
  ["有帮助", "都所没还只也已就又才均皆共另尚仍现原拥含具享占固特"], ["有助于", "都所没还只也已就又才均皆共另尚仍现原拥含具享占固特"], ["帮助", ""], ["健康", ""],
  // F4 attributed feeling.
  ["感到", ""], ["觉得", ""], ["可能", ""], ["疲惫", ""], ["担心", ""], ["辛苦", ""],
].map((entry) => Object.freeze(entry as [string, string])));
/** One regex over every split point of every cue word: `(left half)` + one 、/， (optionally spaced) + lookahead `(right half)`. */
const R12_CUE_WORD_SPLIT = new RegExp(
  R12_ZH_SPLIT_CUE_WORDS.flatMap(([word, notAfter]) => {
    const chars = [...word];
    return chars.slice(1).map((_, index) => `${notAfter ? `(?<![${notAfter}])` : ""}(${chars.slice(0, index + 1).join("")})\\s*[、，,]\\s*(?=${chars.slice(index + 1).join("")})`);
  }).join("|"),
  "g",
);
/** Removes a single 、/， that sits strictly inside one listed cue word, keeping both halves; nothing else changes. */
export function r12CueWordJoined(text: string): string {
  return text.replace(R12_CUE_WORD_SPLIT, (...args: unknown[]) => String(args.slice(1).find((group) => typeof group === "string") ?? args[0]));
}
/** The closed cue-word list (words only; the not-after characters are exclusions, not rule vocabulary), exported read-only for the tests. */
export const SHELL_R12_SPLIT_CUE_WORDS: readonly string[] = Object.freeze(R12_ZH_SPLIT_CUE_WORDS.map(([word]) => word));

/** Rules r4: the evaluation-only S7 register detail. */
export type ShellRegisterCode = "INFORMAL_SECOND_PERSON";
/** Rules r4: the informal second person in zh-SG (你, and 妳 in either script form); non-global, one test per copy. */
const INFORMAL_SECOND_PERSON = Object.freeze(/[你妳]/u);
/**
 * Rules r4 register (S7), zh-SG only: the model wording (slot tokens already removed by the caller) may not address the
 * person with 你 or 妳, read on the original text and on every zh scan copy (folded, joined, look-alike and their
 * Traditional→Simplified copies). en-SG has no register rule (null).
 */
export function shellRegisterViolation(text: string, locale: AiLocale): ShellRegisterCode | null {
  if (locale !== "zh-SG") return null;
  return [text, ...shellScanCopies(text, locale)].some((copy) => INFORMAL_SECOND_PERSON.test(copy)) ? "INFORMAL_SECOND_PERSON" : null;
}
/**
 * S6 directives, read on the scan copies (folding and joining are idempotent, so already folded text is unchanged).
 * Rules r3: the r3 entries too, and for en-SG every pair-joined candidate as a standalone word.
 */
export function shellDirectiveViolation(text: string, locale?: AiLocale): boolean {
  const copies = locale ? shellScanCopies(text, locale) : [foldShellScanText(text)];
  if (copies.some((scan) => SHELL_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(scan)))) return true;
  // Rules r12 fix round 1: the r12 zh clause patterns, on the clause-preserving copies.
  if (locale && shellClauseScanTexts(text, locale).some((scan) => SHELL_CLAUSE_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(scan)))) return true;
  return locale === "en-SG" && pairJoinedCandidates(copies).some((candidate) => SHELL_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(candidate)));
}

/** Rules r5: the closed clinical-label categories (the evaluation-only S6b detail), in the order the scan reports them. */
export type ShellClinicalLabelCategory = "DISEASE_OR_CONDITION" | "DIAGNOSIS" | "SYMPTOM" | "MEDICATION" | "TREATMENT" | "CLINICAL_LABEL";
export const CLINICAL_LABEL_CATEGORIES: readonly ShellClinicalLabelCategory[] = Object.freeze(["DISEASE_OR_CONDITION", "DIAGNOSIS", "SYMPTOM", "MEDICATION", "TREATMENT", "CLINICAL_LABEL"]);
type ClinicalEntries = Readonly<{ en: readonly string[]; zh: readonly string[] }>;
const entries = (en: readonly string[], zh: readonly string[]): ClinicalEntries => Object.freeze({ en: Object.freeze([...en]), zh: Object.freeze([...zh]) });
/**
 * Rules r6 clinical-label entries (owner instruction 2026-10-06), closed, by category. They replace the r5 patterns.
 * en: lower-case complete words, each inflection listed (prefixed forms too: no stem, no prefix or suffix rule), or exact
 * phrases whose words are separated by one space (any whitespace run in the text) or a hyphen; matched case-insensitively on
 * letter boundaries, so never inside a longer word. "treat", "treated", "treating" and "treats" are removed; "condition(s)",
 * "medical" and "surgery" stay. Kept r5 inflections are listed explicitly; "therapist" forms are kept from the r5 therap- rule.
 * zh: deliberate Simplified forms matched as substrings of every zh scan copy (Traditional through the T→S copy); the r5
 * single characters 诊 病 炎 症 痛 疼 疗 治 晕 咳 肿 呕 剂 疾 药 and the bare 点滴 are replaced; 癌 stays (always cancer).
 * 不适 matches only when it is not followed by 合, 用, 宜 or 应 (ZH_NOT_FOLLOWED_BY).
 */
export const CLINICAL_LABEL_ENTRIES: Readonly<Record<ShellClinicalLabelCategory, ClinicalEntries>> = Object.freeze({
  DISEASE_OR_CONDITION: entries([
    "disease", "diseases", "illness", "illnesses", "condition", "conditions", "disorder", "disorders", "syndrome", "syndromes", "chronic", "chronically",
    "diabetes", "diabetic", "diabetics", "prediabetes", "prediabetic", "nondiabetic", "nondiabetics",
    "antidiabetic", "antidiabetics",
    "hypertension", "hypertensive", "antihypertensive", "antihypertensives", "hypotension", "hypotensive",
    "cancer", "cancers", "cancerous", "precancerous", "tumour", "tumours", "tumor", "tumors",
    "infection", "infections", "infected", "infectious", "noninfectious", "reinfection", "reinfections", "infect", "infects", "infecting", "infective",
    "asthma", "asthmatic", "stroke", "strokes", "heart attack", "heart attacks", "heart disease", "heart diseases", "kidney disease", "kidney diseases",
    "obesity", "obese", "anaemia", "anemia", "anaemic", "anemic", "depression", "anxiety", "dementia", "epilepsy", "epileptic", "arthritis",
    "hyperglycaemia", "hyperglycemia", "hyperglycaemic", "hyperglycemic", "hypoglycaemia", "hypoglycemia", "hypoglycaemic", "hypoglycemic",
    "high blood pressure", "blood sugar",
    "sick", "sickness", "sicknesses", "unwell", "flu", "influenza", "allergy", "allergies", "allergic", "cholesterol", "thyroid", "heart failure", "cardiac", "renal", "copd",
    "inflammation", "inflammations", "inflamed", "injury", "injuries", "injured", "migraine", "migraines", "seizure", "seizures", "insomnia",
    "complication", "complications", "relapse", "relapses", "remission", "flare-up", "flare-ups", "flare up", "flare ups", "flareup", "flareups",
    "mental health", "psychiatric", "overweight", "covid",
  ], [
    "疾病", "病情", "生病", "患病", "发病", "病史", "病毒", "病症", "慢性病", "传染病", "心脏病", "肾病", "糖尿病", "糖尿", "癌",
    "炎症", "发炎", "肺炎", "关节炎", "胃炎", "肝炎", "皮炎", "并发症", "后遗症", "抑郁症", "焦虑症", "痴呆症", "失智症", "肿瘤",
    "高血压", "低血压", "血压高", "感染", "中风", "抑郁", "忧郁", "焦虑", "痴呆", "失智", "癫痫", "肥胖", "贫血", "血糖", "哮喘",
    "患有", "罹患", "患者", "感冒", "流感", "过敏", "胆固醇", "甲状腺", "失眠", "骨折", "受伤", "复发",
    // r6 fix round 1: sibling forms.
    "痛风", "鼻炎", "肠炎", "咽炎", "支气管炎", "胃病", "肝病", "肺病", "病人", "重病", "风湿", "湿疹",
  ]),
  DIAGNOSIS: entries([
    "diagnosis", "diagnoses", "diagnose", "diagnosed", "diagnosing", "diagnostic", "diagnostics",
    "undiagnosed", "misdiagnosed", "misdiagnosis", "misdiagnoses", "misdiagnose", "prediagnosis",
  ], ["诊断", "确诊", "误诊", "漏诊", "诊治"]),
  SYMPTOM: entries([
    "symptom", "symptoms", "symptomatic", "pain", "pains", "painful", "ache", "aches", "ached", "aching", "headache", "headaches", "fever", "fevers", "feverish",
    "cough", "coughs", "coughed", "coughing", "dizziness", "dizzy", "nausea", "nauseous", "nauseated", "vomit", "vomits", "vomited", "vomiting", "fatigue", "fatigued",
    "rash", "rashes", "swelling", "swollen", "bleeding", "bled", "shortness of breath",
    "constipation", "diarrhoea", "diarrhea", "cramp", "cramps", "cramping", "cramped", "palpitation", "palpitations", "breathless", "breathlessness", "wheeze", "wheezed", "wheezing", "sore",
  ], [
    "症状", "疼痛", "头痛", "胃痛", "腹痛", "胸痛", "背痛", "腰痛", "牙痛", "酸痛", "关节痛", "头疼", "肚子疼", "头晕", "眩晕", "晕厥", "晕倒",
    "咳嗽", "咳痰", "干咳", "肿胀", "水肿", "红肿", "浮肿", "呕吐", "干呕", "发烧", "发热", "恶心", "出血", "疲劳", "乏力", "皮疹",
    "难受", "不舒服", "身体不适", "不适", "抽筋", "心悸", "麻木", "发冷", "拉肚子", "腹泻", "便秘", "胸闷", "气喘",
    // r6 fix round 1: sibling forms (no single-character pain form: 很痛 and 有点疼 stay unlisted).
    "肚子痛", "胃疼", "牙疼", "腰疼", "背疼", "腿痛", "腿疼", "喉咙痛", "嗓子痛", "心绞痛", "咳血", "便血", "发晕", "头昏",
    // r6 fix round 2: further sibling forms.
    "嗓子疼", "脚痛", "脚疼", "膝盖痛", "膝盖疼",
  ]),
  MEDICATION: entries([
    "medication", "medications", "medicine", "medicines", "medicinal", "drug", "drugs", "pill", "pills", "tablet", "tablets", "capsule", "capsules",
    "dose", "doses", "dosage", "dosages", "dosing", "insulin", "prescription", "prescriptions", "prescribe", "prescribed", "prescribes",
    "antibiotic", "antibiotics", "injection", "injections", "side effect", "side effects", "side-effect", "side-effects",
    "vaccine", "vaccines", "vaccination", "vaccinations", "inhaler", "inhalers", "overdose", "overdoses", "meds",
    "medicate", "medicated", "medicating", "premedication", "medicates", "unmedicated", "overmedicated",
  ], [
    "药物", "用药", "服药", "吃药", "药片", "药丸", "药品", "西药", "中药", "降压药", "降糖药", "止痛药", "抗生素", "药剂", "针剂", "片剂", "剂量",
    "胰岛素", "处方", "注射", "胶囊", "副作用", "疫苗", "接种", "输液", "打点滴", "挂点滴", "吊针", "药膏", "药水", "开药", "配药",
  ]),
  TREATMENT: entries([
    "treatment", "treatments", "therapy", "therapies", "therapeutic", "therapeutics", "surgery", "surgeries", "surgical",
    "chemo", "chemotherapy", "chemotherapies", "radiotherapy", "radiotherapies", "physiotherapy", "psychotherapy", "hydrotherapy",
    "immunotherapy", "immunotherapies", "physio", "rehab", "rehabilitation",
    "postoperative", "post-operative", "untreated", "treatable",
    "therapist", "therapists", "physiotherapist", "physiotherapists", "psychotherapist", "psychotherapists", "hydrotherapist",
  ], [
    "治疗", "医治", "根治", "救治", "治病", "疗法", "疗程", "疗效", "化疗", "放疗", "理疗", "手术", "开刀", "住院", "康复", "复健", "化验", "医嘱", "针灸",
    "治愈", "治好", "诊疗",
  ]),
  CLINICAL_LABEL: entries(["clinical", "clinically", "medical", "medically", "pathology", "pathological", "prognosis", "prognoses"], ["临床", "医学"]),
});
/** Rules r6: a zh entry that is a label only when the next character is not one of these (不适合, 不适用, 不适宜, 不适应). */
const ZH_NOT_FOLLOWED_BY: ReadonlyMap<string, string> = new Map([["不适", "合用宜应"]]);
/**
 * Rules r6 neutral logistics and context phrases (owner instruction 2026-10-06), closed and exact; 病历 added in fix round 1.
 * Fix round 1 (coverage suppression): on every base scan copy each whole phrase (en case-insensitive, on letter boundaries, words
 * separated by whitespace only, never by a slot token; zh as written, Traditional through the T→S copy) marks the characters it
 * covers. A clinical-label match — on the copy, on the en pair/triple-joined candidates or on the zh joined copy (each joined
 * character mapped back to its source character) — is ignored only when every one of its characters is covered (one phrase or
 * adjacent phrases); otherwise it is a hit. So "medical team" and 医生、病历 pass, while "clinic al" (clinical), 确、诊所需 (确诊),
 * 中药房 and 医生、病了 (生病) still hit. Standalone "medical" and "surgery" stay labels.
 */
export const CLINICAL_NEUTRAL_PHRASES: ClinicalEntries = entries(
  ["care team", "medical team", "medical appointment", "clinic", "doctor", "pharmacy", "GP surgery"],
  ["护理团队", "医生", "预约", "诊所", "门诊", "复诊", "就诊", "医疗团队", "药房", "体检", "病历"],
);
const longestFirst = (left: string, right: string): number => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0);
/** An en alternation of complete words and phrases on letter boundaries (a space in an entry reads any whitespace run). */
const enAlternation = (words: readonly string[]): string => `(?<![A-Za-z])(?:${[...words].sort(longestFirst).map((word) => word.replaceAll(" ", "\\s+")).join("|")})(?![A-Za-z])`;
const zhAlternation = (forms: readonly string[]): string => [...forms].sort(longestFirst).map((form) => (ZH_NOT_FOLLOWED_BY.has(form) ? `${form}(?![${ZH_NOT_FOLLOWED_BY.get(form)}])` : form)).join("|");
/**
 * Every r6 clinical-label pattern (category, pattern), frozen and non-global: one en and one zh pattern per category, in category
 * order, built from CLINICAL_LABEL_ENTRIES (longest entry first). Exported read-only for the Traditional-coverage test.
 */
export const CLINICAL_LABEL_RULES: ReadonlyArray<readonly [ShellClinicalLabelCategory, RegExp]> = Object.freeze(CLINICAL_LABEL_CATEGORIES.flatMap((category) => [
  Object.freeze([category, Object.freeze(new RegExp(enAlternation(CLINICAL_LABEL_ENTRIES[category].en), "i"))] as const),
  Object.freeze([category, Object.freeze(new RegExp(zhAlternation(CLINICAL_LABEL_ENTRIES[category].zh)))] as const),
]));
/**
 * Rules r6 fix round 1: the separator S6b puts in place of each slot token (a private-use character, so it survives folding and is
 * no space): a neutral phrase never matches across it, while a label still reads it as a space (dia{{S2}}betes, 糖{{S2}}尿病).
 */
export const CLINICAL_TOKEN_SEPARATOR = "\uE001";
/** Fresh global matchers for the neutral phrases (en, zh) per call, so no lastIndex state is shared. */
const neutralPhraseMatchers = (): readonly RegExp[] => [new RegExp(enAlternation(CLINICAL_NEUTRAL_PHRASES.en), "gi"), new RegExp(zhAlternation(CLINICAL_NEUTRAL_PHRASES.zh), "g")];
/** One clinical scan candidate: its text and, when any neutral phrase was found, which of its characters a phrase covers. */
type ClinicalCandidate = Readonly<{ text: string; covered: readonly boolean[] | null }>;

/** Rules r6 fix round 1: the characters of one base copy that a neutral phrase covers, or null when none does. */
function neutralCoverage(copy: string): boolean[] | null {
  const covered: boolean[] = new Array<boolean>(copy.length).fill(false);
  let any = false;
  for (const matcher of neutralPhraseMatchers()) {
    for (const match of copy.matchAll(matcher)) {
      for (let index = match.index; index < match.index + match[0].length; index += 1) covered[index] = true;
      any = true;
    }
  }
  return any ? covered : null;
}
/** The coverage of a derived text whose character k comes from source character `source[k]`. */
const mapCoverage = (covered: readonly boolean[] | null, source: readonly number[]): boolean[] | null => (covered ? source.map((index) => covered[index]!) : null);

/**
 * Rules r6 fix round 1: joinedZhScanText with an index map (the same separator removal, repeated until stable), so each joined
 * character keeps the position of its source character.
 */
function joinedZhWithSource(text: string): Readonly<{ text: string; source: number[] }> {
  let current = text;
  let source = Array.from({ length: text.length }, (_, index) => index);
  for (;;) {
    const removed = new Array<boolean>(current.length).fill(false);
    let any = false;
    for (const match of current.matchAll(ideographSeparator())) {
      for (let index = match.index; index < match.index + match[0].length; index += 1) removed[index] = true;
      any = any || match[0].length > 0;
    }
    if (!any) return { text: current, source };
    source = source.filter((_, index) => !removed[index]);
    // Positions are UTF-16 code units, as the matcher's indices are.
    current = current.split("").filter((_, index) => !removed[index]).join("");
  }
}

/**
 * Rules r6 fix round 1: the en pair/triple-joined candidates of one copy (the unchanged r3 rule of pairJoinedCandidates: two or
 * three adjacent letter runs separated by exactly one of space - _ . ' /), each with the source positions of its letters.
 */
function pairJoinedWithSource(copy: string): Array<Readonly<{ text: string; source: number[] }>> {
  const runs = [...copy.matchAll(/[A-Za-z]+/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  const joinable = (index: number) => runs[index + 1]!.start - runs[index]!.end === 1 && " -_.'/".includes(copy[runs[index]!.end]!);
  const positions = (run: (typeof runs)[number]) => Array.from({ length: run.end - run.start }, (_, offset) => run.start + offset);
  const candidates: Array<Readonly<{ text: string; source: number[] }>> = [];
  for (let index = 0; index + 1 < runs.length; index += 1) {
    if (!joinable(index)) continue;
    const [first, second] = [runs[index]!, runs[index + 1]!];
    candidates.push({ text: first.text + second.text, source: [...positions(first), ...positions(second)] });
    if (index + 2 < runs.length && joinable(index + 1)) {
      const third = runs[index + 2]!;
      candidates.push({ text: first.text + second.text + third.text, source: [...positions(first), ...positions(second), ...positions(third)] });
    }
  }
  return candidates;
}

/**
 * Whether `pattern` matches the candidate with at least one character outside the neutral coverage. Without coverage this is
 * `pattern.test`; with coverage every start position is tried (alternatives are longest first, so the longest match at a start is
 * the one checked: if it is covered, every shorter one there is too).
 */
function uncoveredMatch(pattern: RegExp, candidate: ClinicalCandidate): boolean {
  if (!pattern.test(candidate.text)) return false;
  const covered = candidate.covered;
  if (!covered) return true;
  const sticky = new RegExp(pattern.source, `${pattern.flags}y`);
  for (let start = 0; start < candidate.text.length; start += 1) {
    sticky.lastIndex = start;
    const match = sticky.exec(candidate.text);
    if (match && covered.slice(start, start + match[0].length).some((isCovered) => !isCovered)) return true;
  }
  return false;
}

/**
 * Rules r6 (S6b; coverage suppression since fix round 1) over one shell text whose slot tokens the caller replaced (S6b uses
 * CLINICAL_TOKEN_SEPARATOR; a space also works): the first category, in the closed category order, with an uncovered match on any
 * clinical scan candidate; null when none. Base copies come from the folded scan copy: zh-SG the scan copy and its look-alike copy
 * plus the T→S copy of each when different; en-SG the scan copy ("_" read as a space) and its look-alike copy. Neutral coverage is
 * computed on each base copy, zh-SG on its T→S form (where a token separator still blocks a phrase); the label text is the base copy with each token
 * separator read as a space. Candidates: that label text; zh-SG its joined copy (joinedZhScanText rule, coverage mapped back);
 * en-SG its pair/triple-joined candidates (pairJoinedCandidates rule, each tested as a whole word, coverage mapped back). en and zh
 * patterns apply in both locales. Scanning only: the displayed text is never rewritten.
 */
export function shellClinicalLabel(text: string, locale: AiLocale): ShellClinicalLabelCategory | null {
  const scan = foldShellScanText(text, locale);
  const bases = locale === "zh-SG" ? [scan, zhLookAlike(scan)] : [scan, enLookAlike(scan)];
  if (locale === "zh-SG") {
    for (const base of bases.slice()) {
      const simplified = toSimplified(base);
      if (!bases.includes(simplified)) bases.push(simplified);
    }
  }
  const candidates: ClinicalCandidate[] = [];
  for (const base of bases) {
    // Coverage is read on the T→S form of the base copy (character for character, same length), so a Traditional neutral phrase
    // (醫生病歷) covers the same characters as its Simplified form.
    const covered = neutralCoverage(locale === "zh-SG" ? toSimplified(base) : base);
    const labelText = base.replaceAll(CLINICAL_TOKEN_SEPARATOR, " ");
    candidates.push({ text: labelText, covered });
    const derived = locale === "zh-SG" ? [joinedZhWithSource(labelText)] : pairJoinedWithSource(labelText);
    for (const { text: derivedText, source } of derived) candidates.push({ text: derivedText, covered: mapCoverage(covered, source) });
  }
  for (const category of CLINICAL_LABEL_CATEGORIES) {
    for (const [ruleCategory, pattern] of CLINICAL_LABEL_RULES) {
      if (ruleCategory === category && candidates.some((candidate) => uncoveredMatch(pattern, candidate))) return category;
    }
  }
  return null;
}

/**
 * Rules r8 (S6 placeholder provenance): every text the S6 directive rule reads for one S6 scan copy, in a fixed order — the
 * copies shellDirectiveViolation reads, then (en-SG) each copy's pair/triple-joined candidates, one per join (not deduplicated, so
 * the list for a copy built with the stand-in and the list for the same copy built with its shadow stay aligned item by item).
 * A directive pattern matches one of these texts exactly when shellDirectiveViolation(text, locale) is true.
 */
export function shellDirectiveScanTexts(text: string, locale: AiLocale): string[] {
  const copies = shellScanCopies(text, locale);
  return locale === "en-SG" ? [...copies, ...copies.flatMap((copy) => pairJoinedWithSource(copy).map((candidate) => candidate.text))] : [...copies];
}

/**
 * Rules r8: the S6 token-separated text — the field text whose slot tokens the caller replaced by CLINICAL_TOKEN_SEPARATOR, folded
 * (the separator survives folding, so no whitespace around a token is removed as an ideograph gap), then each separator read as a
 * space. The scan copies of this text join across a token only through the existing joined-copy rules (zh joined copy, en
 * pair/triple joins), so a model-written split (应{{S2}}该, 建{{S2}}议, Pl{{S2}}ease) still reads as the word; it holds no stand-in, so
 * every match there is made of model characters by construction.
 */
export function tokenSeparatedScanText(separated: string, locale: AiLocale): string {
  return foldShellScanText(separated, locale).replaceAll(CLINICAL_TOKEN_SEPARATOR, " ");
}

/** Rules r8: the shadow alphabets (never mapped by a fold, look-alike, T→S or join rule; see standInShadow). */
const SHADOW_LETTERS = "xqzjk";
const SHADOW_IDEOGRAPHS = "甲乙丙丁";
const SHADOW_IDEOGRAPH = /^[一-鿿]$/u;
/**
 * Rules r8: the same-shape shadow of a stand-in — each ASCII letter becomes the first of x q z j k that differs from it (ignoring
 * case), each CJK ideograph the first of 甲 乙 丙 丁 that differs from it, a space stays a space. The shadow characters behave as the
 * stand-in's under every scan-copy rule (letters stay letters and none is I, l, r, n, v, w or _; ideographs stay ideographs with no
 * Traditional→Simplified or look-alike mapping), so a copy built with the shadow is aligned character for character with the copy
 * built with the stand-in. Any other character (digit, punctuation, symbol, other whitespace, other script) gives null and S6 fails
 * closed (every match counts, as in r7).
 */
export function standInShadow(standIn: string): string | null {
  if (standIn.length === 0 || standIn.trim() !== standIn) return null;
  const shadow: string[] = [];
  for (const character of standIn) {
    if (character === " ") shadow.push(" ");
    else if (/^[A-Za-z]$/.test(character)) shadow.push([...SHADOW_LETTERS].find((letter) => letter !== character.toLowerCase())!);
    else if (SHADOW_IDEOGRAPH.test(character) && !TRADITIONAL_TO_SIMPLIFIED.has(character)) shadow.push([...SHADOW_IDEOGRAPHS].find((ideograph) => ideograph !== character)!);
    else return null;
  }
  return shadow.join("");
}

/** Rules r8: one stand-in occurrence in one scan text — the positions of each of the stand-in's words, null for a word absent from that text. */
export type StandInOccurrence = ReadonlyArray<readonly number[] | null>;
/**
 * Rules r8: where the shadowed occurrence sits in `text` (a scan text built with the stand-in at every token), found by comparing it
 * with `shadowed` (the same scan text built with that one occurrence's stand-in replaced by `shadow`): the positions where the two
 * differ. They must spell a run of whole stand-in words (the stand-in's words are its space-separated parts: "the item" has two,
 * 该项 one), the stand-in in `text` and the shadow in `shadowed`; the result gives each word's positions (null for a word absent from
 * this text; every word null when the occurrence is absent). Anything else — different lengths, a partial word, other characters —
 * is null: the provenance is unknown and S6 fails closed for this text.
 */
export function standInOccurrence(text: string, shadowed: string, standIn: string, shadow: string): StandInOccurrence | null {
  const words = standIn.split(" ");
  const shadowWords = shadow.split(" ");
  if (text.length !== shadowed.length || shadowWords.length !== words.length) return null;
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) if (text[index] !== shadowed[index]) positions.push(index);
  if (positions.length === 0) return words.map(() => null);
  const found = positions.map((index) => text[index]).join("");
  const foundShadow = positions.map((index) => shadowed[index]).join("");
  let match: StandInOccurrence | null = null;
  for (let first = 0; first < words.length; first += 1) {
    for (let last = first; last < words.length; last += 1) {
      if (words.slice(first, last + 1).join("") !== found || shadowWords.slice(first, last + 1).join("") !== foundShadow) continue;
      if (match !== null) return null;
      let offset = 0;
      match = words.map((word, wordIndex) => {
        if (wordIndex < first || wordIndex > last) return null;
        const own = positions.slice(offset, offset + word.length);
        offset += word.length;
        return own;
      });
    }
  }
  return match;
}

/** Rules r8: an ASCII word character, the only kind that joins with a neighbour into one word (CJK ideographs never form such a word). */
const WORD_CHARACTER = /^[A-Za-z0-9_]$/;
/**
 * Rules r8: whether `pattern` (non-global) has a match in `text` that does not split a stand-in occurrence. A match is discarded when,
 * for some occurrence, it holds part of one of the stand-in's words (some but not all of its characters: 应 + 该 of 该项, "e i" of
 * "the item"), or when a stand-in character it holds is directly joined, inside the match, to a model-written ASCII word character
 * (one word made of model and stand-in letters, as the en pair/triple joins produce: "sugges" + "the"). So a match counts when it holds
 * no stand-in character, the whole stand-in (医生该项看过), or whole stand-in words standing apart ("saved  the" reads the stand-in's
 * leading word as the determiner of the token's noun phrase). Every start and, for a start whose preferred match is discarded, every
 * other end is tried, so a shorter or longer alternative at the same start still counts when it does not split the stand-in.
 */
export function provenanceSafeMatch(pattern: RegExp, text: string, occurrences: readonly StandInOccurrence[]): boolean {
  if (!pattern.test(text)) return false;
  const present = occurrences.flatMap((occurrence) => occurrence.filter((word): word is readonly number[] => word !== null && word.length > 0));
  if (present.length === 0) return true;
  const standIn = new Set(present.flat());
  const valid = (start: number, end: number): boolean => {
    for (const word of present) {
      const inside = word.filter((index) => index >= start && index < end).length;
      if (inside === 0) continue;
      if (inside !== word.length) return false;
      for (const index of word) {
        for (const neighbour of [index - 1, index + 1]) {
          if (neighbour < start || neighbour >= end || standIn.has(neighbour)) continue;
          if (WORD_CHARACTER.test(text[index]!) && WORD_CHARACTER.test(text[neighbour]!)) return false;
        }
      }
    }
    return true;
  };
  const flags = pattern.flags.replace(/[gy]/g, "");
  const sticky = new RegExp(pattern.source, `${flags}y`);
  for (let start = 0; start <= text.length; start += 1) {
    sticky.lastIndex = start;
    const preferred = sticky.exec(text);
    if (!preferred) continue;
    if (valid(start, start + preferred[0].length)) return true;
    for (let end = start; end <= text.length; end += 1) {
      if (end === start + preferred[0].length || !valid(start, end)) continue;
      // A match of the same pattern from `start` that ends exactly at `end` (exactly `end` characters before the end of the match).
      const ending = new RegExp(`(?:${pattern.source})(?<=[\\s\\S]{${end}})(?<![\\s\\S]{${end + 1}})`, `${flags}y`);
      ending.lastIndex = start;
      if (ending.exec(text)) return true;
    }
  }
  return false;
}
