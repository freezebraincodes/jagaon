/**
 * Owner decision 2026-10-14 (HSA-bounded mode, PREVIEW feature "Meal ideas"): a small static list of common Singapore food swaps,
 * shown on Today only while HSA-bounded mode is OFF. General, HPB-style "healthier choice" ideas in plain words: no amounts, no
 * numbers, no medical claims and nothing addressed to a condition. Loaded lazily (dynamic import) only when the preview tile renders.
 *
 * English only (demo scope). Each meal keeps the same number of swaps so the daily rotation stays even.
 */
import type { MealIdeaSlot } from "./meal-ideas";

export const MEAL_IDEAS_VERSION = "meal-ideas.1";

export type MealSwap = Readonly<{
  /** Stable key for rendering. */
  id: string;
  /** What people often have. */
  from: string;
  /** The healthier choice people often try instead. */
  to: string;
}>;

export const MEAL_IDEAS: Readonly<Record<MealIdeaSlot, readonly MealSwap[]>> = Object.freeze({
  BREAKFAST: Object.freeze([
    { id: "kaya-toast", from: "Kaya toast", to: "wholemeal bread, kaya on the side" },
    { id: "teh", from: "Teh with condensed milk", to: "teh-c kosong" },
    { id: "kopi", from: "Kopi with condensed milk", to: "kopi-o kosong" },
    { id: "roti-prata", from: "Roti prata", to: "thosai" },
    { id: "nasi-lemak", from: "Nasi lemak", to: "wholemeal egg sandwich" },
    { id: "fried-bee-hoon", from: "Fried bee hoon", to: "brown rice bee hoon" },
    { id: "sweetened-cereal", from: "Sweetened cereal", to: "plain rolled oats" },
    { id: "fruit-juice", from: "Fruit juice", to: "a whole fruit" },
    { id: "white-bread", from: "White bread", to: "wholegrain bread" },
  ]),
  LUNCH: Object.freeze([
    { id: "chicken-rice", from: "Chicken rice", to: "ask for brown rice" },
    { id: "fried-noodles", from: "Fried noodles", to: "yong tau foo soup" },
    { id: "mee-goreng", from: "Mee goreng", to: "sliced fish soup with rice (less rice)" },
    { id: "char-kway-teow", from: "Char kway teow", to: "thunder tea rice with brown rice" },
    { id: "nasi-briyani", from: "Nasi briyani", to: "brown rice with dhal and vegetables" },
    { id: "fried-chicken", from: "Fried chicken", to: "grilled chicken" },
    { id: "economy-rice", from: "Economy rice with fried dishes", to: "steamed and vegetable dishes" },
    { id: "soft-drink", from: "Soft drink", to: "plain water or unsweetened tea" },
    { id: "bubble-tea", from: "Bubble tea", to: "unsweetened tea, or ask for less sweet" },
  ]),
  DINNER: Object.freeze([
    { id: "white-rice", from: "White rice", to: "brown rice or half-half rice" },
    { id: "fried-rice", from: "Fried rice", to: "brown rice with stir-fried vegetables" },
    { id: "sweet-sour-pork", from: "Sweet and sour pork", to: "steamed fish" },
    { id: "coconut-curry", from: "Curry with coconut milk", to: "clear soup dishes" },
    { id: "murtabak", from: "Murtabak", to: "chapati with dhal" },
    { id: "fried-tofu", from: "Deep-fried tofu", to: "steamed tofu" },
    { id: "laksa", from: "Laksa", to: "clear soup noodles with more vegetables" },
    { id: "ice-kacang", from: "Ice kacang", to: "cut fruit" },
    { id: "supper-biscuits", from: "Supper biscuits", to: "a small handful of unsalted nuts" },
  ]),
});
