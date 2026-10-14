import type { AppMessages, SupportedLocale } from "@/i18n/types";

/**
 * Packet 13 (P13S step 4): the Tell JagaOn screen's copy. Approved catalogue rows are read from `messages` (voice-copy.13s.1,
 * aiAccess.passcodeLabel, shared). The screen's own rows, `VOICE_SCREEN_PENDING_COPY`, are the single source of voice-copy.13s.2
 * (screen-local; human acceptance pending; catalogue migration deferred by coordinator ruling). Nothing here is advice; nothing
 * interpolates a transcript except the spoken phrase being asked about, and an amount exactly as it was said.
 */
export type VoiceScreenCopy = Readonly<{
  title: string;
  passcodeLabel: string;
  close: string;
  disclosure: AppMessages["voice"]["disclosure"];
  state: AppMessages["voice"]["state"] & Readonly<{ starting: string; accessDenied: string; checking: string; declined: string; doneSaved: string }>;
  review: AppMessages["voice"]["review"] &
    Readonly<{
      notUnderstoodHeading: string;
      notUnderstoodBody: string;
      backToToday: string;
      /** Finding N-1 (owner-approved 2026-10-10): the screen-level manual-entry chooser; each label is its destination's own title. */
      manualHeading: string;
      /** Owner decision 2026-10-14: the first action of the chooser starts a new voice session. */
      tellAgain: string;
      manualReading: string;
      manualMeal: string;
      manualMedicine: string;
    }>;
  redirect: AppMessages["voice"]["redirect"] & Readonly<{ healthBody: string }>;
  /** Owner decision 2026-10-14 (distress safety): catalogue rows `voice.distress.*` (EN owner-approved; ZH drafts). */
  distress: AppMessages["voice"]["distress"];
  /** Owner decision 2026-10-14 (Tell JagaOn understands more): catalogue rows `voice.feeling.*` and `voice.activity.*` (ZH drafts). */
  feeling: AppMessages["voice"]["feeling"];
  activity: AppMessages["voice"]["activity"] & Readonly<{ minutes: (count: number) => string }>;
  /** HSA preview (owner decision 2026-10-14): catalogue rows `voice.medicineInfo.*` (ZH drafts). */
  medicineInfo: AppMessages["voice"]["medicineInfo"];
  /** voice-copy.13s.2 `voice.remoteExtraction.*` (the disclosure wording is the coordinator's; human acceptance pending). */
  remote: Readonly<{ offer: string; title: string; disclosure: string; accept: string; decline: string; checking: string; keptLocal: string }>;
  /** Web Speech (VOICE_WEB_SPEECH_COPY; owner-approved wording 2026-10-11). */
  webSpeech: WebSpeechCopy;
  /** W-6a: the listening-limit notice, for both providers (EN owner-approved 2026-10-11; ZH draft). */
  /** `notShown`: text was captured but nothing was understood and no transcript is displayed (round 6). */
  limit: Readonly<{ captured: string; empty: string; notShown: string }>;
  /**
   * Owner decision 2026-10-15: typing to Tell JagaOn. The typed words go through the same on-device checks and cards as speech; no
   * voice notice is needed (no audio leaves the device).
   */
  typing: Readonly<{ start: string; label: string; hint: string; submit: string; transcriptLabel: string }>;
  /** Terminology review Critical #1: the minimal "Words JagaOn remembers" section (list, change, forget). Human acceptance pending. */
  terms: Readonly<{
    heading: string;
    loading: string;
    empty: string;
    meaning: (phrase: string, medicine: string) => string;
    dormant: (phrase: string) => string;
    change: string;
    forget: string;
    changeTitle: (phrase: string) => string;
    forgetTitle: string;
    forgetBody: (phrase: string) => string;
    forgetConfirm: string;
    forgetCancel: string;
    forgotten: string;
    changed: string;
    failed: string;
    stale: string;
  }>;
  card: Readonly<{
    glucose: string;
    meal: string;
    medicine: string;
    /** Finding N-1 (owner-approved 2026-10-10): each card's manual-entry button names its destination. */
    manualGlucose: string;
    manualMeal: string;
    manualMedicine: string;
    save: string;
    leaveOut: string;
    saved: string;
    notSaved: string;
    edit: string;
    needsEdit: string;
    otherPerson: string;
    unitSpoken: string;
    unitAppDefault: string;
    confirmUnit: string;
    valueLabel: string;
    enterValueYourself: string;
    slotLabel: string;
    slotUnstated: string;
    slots: Readonly<Record<"BREAKFAST" | "LUNCH" | "DINNER" | "SUPPER", string>>;
    itemsLabel: string;
    noItems: string;
    medicineUnresolved: (phrase: string) => string;
    chooseMedicine: string;
    leaveUnresolved: string;
    rememberLabel: (phrase: string, medicine: string) => string;
    rememberHint: string;
    remembered: string;
    rememberFailed: string;
    statusQuestion: string;
    statusTaken: string;
    statusSkipped: string;
    statusUnknown: string;
    planned: string;
    amountReported: (amount: string) => string;
    /** 13s.3: a TAKEN event whose reported amount the save path stores. */
    amountWillBeSaved: string;
    amountNotSaved: string;
    /**
     * CR-11 (owner decisions 2026-10-11, design v3.1; replaces the 13s.3 OUT_OF_RANGE wording): the confirmation panel inside the card.
     * `confirmBody` is the owner-approved verification copy, verbatim (all three sentences on the voice card). The control labels are
     * the approved EN labels and the R-3 ZH labels. `unitText` is the unit shown beside the formatted value ("60.0 mmol/L").
     */
    confirmBody: string;
    saveAsShown: string;
    editReading: string;
    cancel: string;
    unitText: string;
    /** CR-11: a typed or pasted value with more than one decimal digit (or anything but digits and one point) is refused, never trimmed. Wording owner-approved 2026-10-11. */
    valueFormatRefused: string;
    noMedicines: string;
  }>;
}>;

/**
 * Web Speech (owner-approved scope 2026-10-11). Owner-approved wording, 2026-10-11 (consent version B, early-end notices, health/dose
 * question note). English only: the Chinese UI never
 * offers Web Speech (no ZH speech support in this scope), so these rows have no ZH version; the ZH screen keeps the existing rows.
 * The consent replaces the Tencent disclosure text only for a Web Speech session (its buttons reuse the existing disclosure labels).
 */
export type WebSpeechCopy = Readonly<{
  /** The consent shown before every Web Speech start. */
  consentTitle: string;
  consentBody: readonly string[];
  /** After a browser-initiated end (not the person's Stop), when what was captured is shown below. */
  earlyEnd: string;
  /** After a browser-initiated end before anything was captured. */
  earlyEndEmpty: string;
  /** After a browser-initiated end when text was captured but nothing was understood and no transcript is displayed (round 6). */
  earlyEndNotShown: string;
  /** The redirect screen's note in a Web Speech session (the existing note names Tencent Cloud). */
  transcribedNote: string;
}>;

export const VOICE_WEB_SPEECH_COPY: Readonly<{ "en-SG": WebSpeechCopy }> = Object.freeze({
  // Owner-approved wording, 2026-10-11 (verbatim).
  "en-SG": Object.freeze({
    consentTitle: "Use your browser's speech recognition?",
    consentBody: Object.freeze([
      "Tell JagaOn will use your browser's built-in speech recognition. While you speak, your browser sends the audio to its speech service to turn it into text (in Chrome, this is Google's speech service), which handles it under its own terms. JagaOn does not receive or keep the recording; it receives only the text, which stays on this device for you to check. Nothing is saved until you review it and choose Save.",
      "Your browser may stop listening on its own, for example after a pause. JagaOn will not restart it.",
    ]),
    earlyEnd: "The browser stopped listening. Check what was captured below. Nothing has been saved.",
    earlyEndEmpty: "The browser stopped listening before anything was captured. Nothing has been saved. You can try again or type your entry.",
    earlyEndNotShown: "The browser stopped listening. Nothing has been saved. You can try again or type your entry.",
    transcribedNote: "Your speech was turned into text by your browser's speech service (Google, in Chrome). JagaOn did not forward this question to another AI service or save it as an entry.",
  }),
});

type PendingCopy = Omit<VoiceScreenCopy, "title" | "passcodeLabel" | "close" | "disclosure" | "state" | "review" | "redirect" | "distress" | "feeling" | "activity" | "medicineInfo" | "remote" | "terms" | "webSpeech" | "limit"> &
  Readonly<{
    state: Readonly<{ starting: string; accessDenied: string; checking: string; declined: string; doneSaved: string }>;
    review: Readonly<{ notUnderstoodHeading: string; notUnderstoodBody: string; backToToday: string; manualHeading: string; tellAgain: string }>;
    redirect: Readonly<{ healthBody: string }>;
    remote: VoiceScreenCopy["remote"];
    terms: VoiceScreenCopy["terms"];
    limit: VoiceScreenCopy["limit"];
  }>;

/** voice-copy.13s.2 (screen-local; human acceptance pending; catalogue migration deferred by coordinator ruling). */
export const VOICE_SCREEN_PENDING_COPY: Readonly<Record<SupportedLocale, PendingCopy>> = Object.freeze({
  "en-SG": {
    state: {
      starting: "Turning on the microphone…",
      accessDenied: "The demo passcode was not accepted. You can type your entry instead.",
      checking: "Checking whether voice is available…",
      declined: "Voice was not turned on. You can type your entry instead.",
      doneSaved: "Done. Saved items stay in your records.",
    },
    review: {
      notUnderstoodHeading: "Not captured",
      notUnderstoodBody: "JagaOn did not save these words or work out what they mean.",
      // Finding N-1 (owner-approved 2026-10-10): a manual-entry chooser, and Back to Today as a separate exit. One chooser heading on
      // every screen that shows it (owner's decision, 2026-10-11).
      backToToday: "Back to Today",
      manualHeading: "Type another entry",
      // Owner decision 2026-10-14.
      tellAgain: "Tell JagaOn again",
    },
    redirect: { healthBody: "JagaOn can record what you report, but cannot assess whether a reading is dangerous or recommend treatment. Please check with your care team." },
    // W-6a: owner-approved wording, 2026-10-11 (verbatim).
    limit: {
      captured: "Listening stopped at the 60-second limit. Check what was captured below. Nothing has been saved.",
      empty: "Listening stopped at the 60-second limit. Nothing was captured, and nothing has been saved.",
      // Round 6: owner-approved wording, 2026-10-11 (verbatim).
      notShown: "Listening stopped at the 60-second limit. Nothing has been saved.",
    },
    // Owner decision 2026-10-15.
    typing: {
      start: "Type to JagaOn",
      label: "What would you like to tell JagaOn?",
      hint: "For example: “My sugar was 6.8 before breakfast” or “I feel tired today”. Nothing is saved until you check it.",
      submit: "Continue",
      transcriptLabel: "What you typed (not saved)",
    },
    remote: {
      offer: "Ask AI to help read what you said",
      title: "Send what you said to AI?",
      disclosure: "If you choose this, the text of what you said (not the recording) is sent to an AI service to suggest what to fill in. JagaOn does not keep the text. You still check and confirm each item; nothing is saved automatically.",
      accept: "Send to AI",
      decline: "Keep it on this device",
      checking: "Asking AI…",
      keptLocal: "JagaOn kept its own reading of what you said.",
    },
    terms: {
      heading: "Words JagaOn remembers",
      loading: "Loading…",
      empty: "JagaOn does not remember any words yet.",
      meaning: (phrase, medicine) => `“${phrase}” means ${medicine}`,
      dormant: (phrase) => `“${phrase}”: this medicine is no longer in your list`,
      change: "Change",
      forget: "Forget",
      changeTitle: (phrase) => `“${phrase}”: which of your medicines is this?`,
      forgetTitle: "Forget this word?",
      forgetBody: (phrase) => `JagaOn will no longer recognise “${phrase}”. Your records are not changed.`,
      forgetConfirm: "Forget",
      forgetCancel: "Keep it",
      forgotten: "Forgotten.",
      changed: "Changed.",
      failed: "Nothing was changed. Please try again.",
      stale: "This word was changed in the meantime. Nothing was changed; the list is updated.",
    },
    card: {
      glucose: "Glucose reading",
      meal: "Meal",
      medicine: "Medicine",
      manualGlucose: "Type the reading yourself",
      manualMeal: "Type the meal yourself",
      manualMedicine: "Record it in Medication schedule",
      save: "Save this",
      leaveOut: "Leave out",
      saved: "Saved.",
      notSaved: "Not saved. Your records are unchanged.",
      edit: "Edit",
      needsEdit: "You said something that may change this (for example “not”, “maybe”, a correction or another number). Type it yourself to save it.",
      otherPerson: "This seems to be about someone else, so it cannot be saved in your records.",
      unitSpoken: "mmol/L (you said it)",
      unitAppDefault: "Unit is the app default (mmol/L)",
      // CR-11 (design v3.1 §2): the explicit unit answer.
      confirmUnit: "Yes, mmol/L",
      valueLabel: "Reading (mmol/L)",
      enterValueYourself: "Type the reading yourself.",
      slotLabel: "Meal",
      slotUnstated: "Meal not said",
      slots: { BREAKFAST: "Breakfast", LUNCH: "Lunch", DINNER: "Dinner", SUPPER: "Supper" },
      itemsLabel: "What you ate",
      noItems: "No food was named.",
      medicineUnresolved: (phrase) => `“${phrase}”: which of your medicines is this?`,
      chooseMedicine: "Choose the medicine",
      leaveUnresolved: "Leave it out",
      rememberLabel: (phrase, medicine) => `Remember that “${phrase}” means ${medicine}`,
      rememberHint: "This only remembers the name. It does not record that you took anything.",
      remembered: "Remembered.",
      rememberFailed: "This could not be remembered. You can choose it again next time.",
      statusQuestion: "Did you take it?",
      statusTaken: "Taken",
      statusSkipped: "Skipped",
      statusUnknown: "Not sure",
      planned: "You said you still need to take it, so nothing will be saved.",
      amountReported: (amount) => `You said: ${amount}. This is what you said, not a recommendation.`,
      amountWillBeSaved: "This amount will be saved with this entry, as you said it.",
      amountNotSaved: "This amount will not be saved.",
      confirmBody: "Please check the number and unit against your meter or sensor display. This reading has not been saved. You can type the reading yourself.",
      saveAsShown: "Save as shown",
      editReading: "Edit reading",
      cancel: "Cancel",
      unitText: "mmol/L",
      valueFormatRefused: "Use digits only, with at most one digit after the decimal point. Nothing was changed.",
      noMedicines: "There are no medicines in your list to choose from.",
    },
  },
  "zh-SG": {
    state: {
      starting: "正在开启麦克风…",
      accessDenied: "演示密码未被接受。您可以改为手动输入。",
      checking: "正在检查语音是否可用…",
      declined: "没有开启语音。您可以改为手动输入。",
      doneSaved: "已完成。已保存的内容会保留在您的记录中。",
    },
    review: {
      notUnderstoodHeading: "未记录的内容",
      notUnderstoodBody: "JagaOn 没有保存这些话，也没有解读它们的意思。",
      // Finding N-1 (owner-approved 2026-10-10): see the EN rows.
      backToToday: "返回“今天”",
      manualHeading: "输入其他内容",
      // Owner decision 2026-10-14; draft, human acceptance pending.
      tellAgain: "再次告诉 JagaOn",
    },
    redirect: { healthBody: "JagaOn 可以记录您报告的内容，但无法评估读数是否危险，也无法建议治疗。请向您的医护团队确认。" },
    // W-6a: ZH for the TRTC limit notice only (the screen copy requires both locales). Draft, pending owner review.
    limit: {
      captured: "已在 60 秒上限时停止聆听。请检查下面记录的内容。尚未保存任何内容。",
      empty: "已在 60 秒上限时停止聆听。没有记录到任何内容，也没有保存任何内容。",
      // Round 6: draft, pending owner review (Chinese acceptance deferred).
      notShown: "已在 60 秒上限时停止聆听。尚未保存任何内容。",
    },
    // Drafts (English only for the hackathon).
    typing: {
      start: "输入给 JagaOn",
      label: "您想告诉 JagaOn 什么？",
      hint: "例如：“早餐前血糖 6.8” 或 “我今天觉得累”。检查之前不会保存任何内容。",
      submit: "继续",
      transcriptLabel: "您输入的内容（未保存）",
    },
    remote: {
      offer: "请 AI 帮忙理解您说的话",
      title: "要把您说的话发送给 AI 吗？",
      disclosure: "如果您选择这一项，您说的话的文字（不是录音）会发送给 AI 服务，用来建议要填写的内容。JagaOn 不保存这些文字。每一项仍由您检查和确认，不会自动保存。",
      accept: "发送给 AI",
      decline: "保留在此设备上",
      checking: "正在询问 AI…",
      keptLocal: "JagaOn 保留了它自己对您说话内容的理解。",
    },
    terms: {
      heading: "JagaOn 记住的说法",
      loading: "正在加载…",
      empty: "JagaOn 还没有记住任何说法。",
      meaning: (phrase, medicine) => `“${phrase}”是指${medicine}`,
      dormant: (phrase) => `“${phrase}”：这种药物已不在您的清单中`,
      change: "修改",
      forget: "忘记",
      changeTitle: (phrase) => `“${phrase}”：这是您的哪一种药物？`,
      forgetTitle: "要忘记这个说法吗？",
      forgetBody: (phrase) => `JagaOn 将不再识别“${phrase}”。您的记录不会改变。`,
      forgetConfirm: "忘记",
      forgetCancel: "保留",
      forgotten: "已忘记。",
      changed: "已修改。",
      failed: "没有任何改变。请再试一次。",
      stale: "这个说法已在别处被修改。没有任何改变；清单已更新。",
    },
    card: {
      glucose: "血糖读数",
      meal: "饮食",
      medicine: "药物",
      manualGlucose: "自己输入读数",
      manualMeal: "自己输入餐食",
      manualMedicine: "在“用药时间表”中记录",
      save: "保存这一项",
      leaveOut: "不保存",
      saved: "已保存。",
      notSaved: "没有保存。您的记录没有改变。",
      edit: "修改",
      needsEdit: "您说的话可能改变了这一项（例如“不是”、“大概”、更正或另一个数字）。请自己输入后再保存。",
      otherPerson: "这似乎是关于其他人的，因此不能保存在您的记录中。",
      unitSpoken: "mmol/L（您说的）",
      unitAppDefault: "单位为应用默认值（mmol/L）",
      confirmUnit: "是，mmol/L",
      valueLabel: "读数（mmol/L）",
      enterValueYourself: "请自己输入读数。",
      slotLabel: "餐次",
      slotUnstated: "没有说是哪一餐",
      slots: { BREAKFAST: "早餐", LUNCH: "午餐", DINNER: "晚餐", SUPPER: "宵夜" },
      itemsLabel: "吃了什么",
      noItems: "没有说吃了什么。",
      medicineUnresolved: (phrase) => `“${phrase}”：这是您的哪一种药物？`,
      chooseMedicine: "选择药物",
      leaveUnresolved: "不填写",
      rememberLabel: (phrase, medicine) => `记住“${phrase}”是指${medicine}`,
      rememberHint: "这只会记住名称，不会记录您用了任何药物。",
      remembered: "已记住。",
      rememberFailed: "无法记住。下次您可以再选择一次。",
      statusQuestion: "您用了吗？",
      statusTaken: "已用",
      statusSkipped: "没用",
      statusUnknown: "不确定",
      planned: "您说还需要用药，所以不会保存。",
      amountReported: (amount) => `您说：${amount}。这是您说的内容，不是建议。`,
      amountWillBeSaved: "这个剂量会按您说的随此记录保存。",
      amountNotSaved: "这个剂量不会被保存。",
      confirmBody: "请核对这里的数字和单位是否与您的血糖仪或传感器显示一致。这项读数尚未保存。您可以自己输入读数。",
      saveAsShown: "按显示内容保存",
      editReading: "修改读数",
      cancel: "取消",
      unitText: "mmol/L",
      valueFormatRefused: "请只输入数字，小数点后最多一位。内容没有改变。",
      noMedicines: "您的药物清单中没有可选择的药物。",
    },
  },
});

export function voiceScreenCopy(messages: AppMessages, locale: SupportedLocale): VoiceScreenCopy {
  const pending = VOICE_SCREEN_PENDING_COPY[locale] ?? VOICE_SCREEN_PENDING_COPY["en-SG"];
  return Object.freeze({
    title: messages.voice.entry,
    passcodeLabel: messages.aiAccess.passcodeLabel,
    close: messages.shared.close,
    disclosure: messages.voice.disclosure,
    state: { ...messages.voice.state, ...pending.state },
    // Finding N-1: the chooser's labels are the destinations' own titles, so a label always matches the screen it opens.
    review: { ...messages.voice.review, ...pending.review, manualReading: messages.today.recordReading, manualMeal: messages.meal.screenTitle, manualMedicine: messages.schedule.title },
    redirect: { ...messages.voice.redirect, ...pending.redirect },
    distress: messages.voice.distress,
    feeling: messages.voice.feeling,
    activity: { ...messages.voice.activity, minutes: messages.shared.minutes },
    medicineInfo: messages.voice.medicineInfo,
    remote: pending.remote,
    limit: pending.limit,
    typing: pending.typing,
    // English only (see VOICE_WEB_SPEECH_COPY): the ZH screen never reaches a Web Speech session.
    webSpeech: VOICE_WEB_SPEECH_COPY["en-SG"],
    terms: pending.terms,
    card: pending.card,
  });
}
