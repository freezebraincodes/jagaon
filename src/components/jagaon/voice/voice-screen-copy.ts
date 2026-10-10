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
  review: AppMessages["voice"]["review"] & Readonly<{ notUnderstoodHeading: string; notUnderstoodBody: string; typeInstead: string }>;
  redirect: AppMessages["voice"]["redirect"] & Readonly<{ healthBody: string }>;
  /** voice-copy.13s.2 `voice.remoteExtraction.*` (the disclosure wording is the coordinator's; human acceptance pending). */
  remote: Readonly<{ offer: string; title: string; disclosure: string; accept: string; decline: string; checking: string; keptLocal: string }>;
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
    /** 13s.3 review rejection OUT_OF_RANGE (a glucose value outside 0 < value ≤ 50 mmol/L): plain wording, manual path. */
    outOfRange: string;
    noMedicines: string;
  }>;
}>;

type PendingCopy = Omit<VoiceScreenCopy, "title" | "passcodeLabel" | "close" | "disclosure" | "state" | "review" | "redirect" | "remote" | "terms"> &
  Readonly<{
    state: Readonly<{ starting: string; accessDenied: string; checking: string; declined: string; doneSaved: string }>;
    review: Readonly<{ notUnderstoodHeading: string; notUnderstoodBody: string }>;
    redirect: Readonly<{ healthBody: string }>;
    remote: VoiceScreenCopy["remote"];
    terms: VoiceScreenCopy["terms"];
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
    review: { notUnderstoodHeading: "Not captured", notUnderstoodBody: "JagaOn did not save these words or work out what they mean." },
    redirect: { healthBody: "JagaOn can record what you report, but cannot assess whether a reading is dangerous or recommend treatment. Please check with your care team." },
    remote: {
      offer: "Ask DeepSeek to help read what you said",
      title: "Send what you said to DeepSeek?",
      disclosure: "If you choose this, the text of what you said (not the recording) is sent to DeepSeek, an AI service, to suggest what to fill in. JagaOn does not keep the text. You still check and confirm each item; nothing is saved automatically.",
      accept: "Send to DeepSeek",
      decline: "Keep it on this device",
      checking: "Asking DeepSeek…",
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
      save: "Save this",
      leaveOut: "Leave out",
      saved: "Saved.",
      notSaved: "Not saved. Your records are unchanged.",
      edit: "Edit",
      needsEdit: "You said something that may change this (for example “not”, “maybe”, a correction or another number). Type it yourself to save it.",
      otherPerson: "This seems to be about someone else, so it cannot be saved in your records.",
      unitSpoken: "mmol/L (you said it)",
      unitAppDefault: "Unit is the app default (mmol/L)",
      confirmUnit: "The unit is mmol/L",
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
      outOfRange: "This number cannot be saved as a reading in mmol/L. Nothing was saved. You can type the reading yourself.",
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
    review: { notUnderstoodHeading: "未记录的内容", notUnderstoodBody: "JagaOn 没有保存这些话，也没有解读它们的意思。" },
    redirect: { healthBody: "JagaOn 可以记录您报告的内容，但无法评估读数是否危险，也无法建议治疗。请向您的医护团队确认。" },
    remote: {
      offer: "请 DeepSeek 帮忙理解您说的话",
      title: "要把您说的话发送给 DeepSeek 吗？",
      disclosure: "如果您选择这一项，您说的话的文字（不是录音）会发送给 AI 服务 DeepSeek，用来建议要填写的内容。JagaOn 不保存这些文字。每一项仍由您检查和确认，不会自动保存。",
      accept: "发送给 DeepSeek",
      decline: "保留在此设备上",
      checking: "正在询问 DeepSeek…",
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
      save: "保存这一项",
      leaveOut: "不保存",
      saved: "已保存。",
      notSaved: "没有保存。您的记录没有改变。",
      edit: "修改",
      needsEdit: "您说的话可能改变了这一项（例如“不是”、“大概”、更正或另一个数字）。请自己输入后再保存。",
      otherPerson: "这似乎是关于其他人的，因此不能保存在您的记录中。",
      unitSpoken: "mmol/L（您说的）",
      unitAppDefault: "单位为应用默认值（mmol/L）",
      confirmUnit: "单位是 mmol/L",
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
      outOfRange: "这个数字不能作为 mmol/L 读数保存。没有保存任何内容。您可以自己输入读数。",
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
    review: { ...messages.voice.review, ...pending.review, typeInstead: messages.voice.disclosure.decline },
    redirect: { ...messages.voice.redirect, ...pending.redirect },
    remote: pending.remote,
    terms: pending.terms,
    card: pending.card,
  });
}
