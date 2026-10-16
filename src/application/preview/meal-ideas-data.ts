/**
 * Owner decision 2026-10-14 (HSA-bounded mode, PREVIEW feature "Meal ideas"): a small static list of common Singapore food swaps,
 * shown on Today only while HSA-bounded mode is OFF. General, HPB-style "healthier choice" ideas in plain words: no amounts, no
 * numbers, no medical claims and nothing addressed to a condition. Loaded lazily (dynamic import) only when the preview tile renders.
 *
 * English only (demo scope). Each meal keeps the same number of swaps so the daily rotation stays even.
 *
 * meal-ideas.2 (owner request 2026-10-15): 24 swaps per meal so "Show other ideas" does not repeat after a few taps; Singapore dishes
 * first, with at most one generic swap in each set of three (the order IS the rotation). Drafted by Claude for the owner's review,
 * line by line; not taken from an official source. Flagged for review: nasi lemak, curry with coconut milk, supper biscuits.
 * Fruit (owner review 2026-10-15): always a small portion of a lower-sugar fruit (apple, orange, pear, guava, berries); never a whole
 * large fruit or a very sweet one (durian, mango, lychee, longan, banana, grapes, dates, jackfruit, rambutan, dried fruit).
 */
import type { MealIdeaSlot } from "./meal-ideas";

export const MEAL_IDEAS_VERSION = "meal-ideas.2";

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
    { id: "kopi", from: "Kopi with condensed milk", to: "kopi-o kosong" },
    { id: "sweetened-cereal", from: "Sweetened cereal", to: "plain rolled oats" },
    { id: "roti-prata", from: "Roti prata", to: "thosai" },
    { id: "teh", from: "Teh with condensed milk", to: "teh-c kosong" },
    { id: "fruit-juice", from: "Fruit juice", to: "a small apple, orange or pear" },
    { id: "nasi-lemak", from: "Nasi lemak", to: "wholemeal egg sandwich" },
    { id: "youtiao", from: "Youtiao with sweetened soy milk", to: "unsweetened soy milk with a wholemeal bun" },
    { id: "white-bread", from: "White bread", to: "wholegrain bread" },
    { id: "fried-bee-hoon", from: "Fried bee hoon", to: "brown rice bee hoon" },
    { id: "fried-carrot-cake", from: "Fried carrot cake", to: "soft-boiled eggs with wholemeal toast" },
    { id: "butter-croissant", from: "Butter croissant", to: "wholemeal bun" },
    { id: "teh-tarik", from: "Teh tarik", to: "teh tarik siew dai (less sweet)" },
    { id: "curry-puff", from: "Curry puff", to: "steamed vegetable pau" },
    { id: "sweetened-yoghurt", from: "Sweetened yoghurt", to: "plain yoghurt with a few berries" },
    { id: "chee-cheong-fun", from: "Chee cheong fun with sweet sauce", to: "chee cheong fun, sauce on the side" },
    { id: "fried-soon-kueh", from: "Fried soon kueh", to: "steamed soon kueh" },
    { id: "pancakes", from: "Pancakes with syrup", to: "wholemeal toast with peanut butter" },
    { id: "milo", from: "Milo with sugar", to: "Milo kosong" },
    { id: "lontong", from: "Lontong", to: "lontong with less gravy, more vegetables" },
    { id: "muffin", from: "Muffin", to: "wholemeal toast with egg" },
    { id: "dry-fishball-noodles", from: "Dry fishball noodles", to: "fishball noodle soup" },
    { id: "putu-mayam", from: "Putu mayam with sugar", to: "putu mayam with less sugar" },
    { id: "ondeh-ondeh", from: "Ondeh ondeh", to: "a small apple or pear" },
  ]),
  LUNCH: Object.freeze([
    { id: "chicken-rice", from: "Chicken rice", to: "ask for brown rice" },
    { id: "hokkien-mee", from: "Hokkien mee", to: "sliced fish bee hoon soup" },
    { id: "fried-chicken", from: "Fried chicken", to: "grilled chicken" },
    { id: "mee-goreng", from: "Mee goreng", to: "sliced fish soup with rice (less rice)" },
    { id: "char-kway-teow", from: "Char kway teow", to: "thunder tea rice with brown rice" },
    { id: "soft-drink", from: "Soft drink", to: "plain water or unsweetened tea" },
    { id: "nasi-briyani", from: "Nasi briyani", to: "brown rice with dhal and vegetables" },
    { id: "dry-wanton-mee", from: "Dry wanton mee", to: "wanton noodle soup with extra greens" },
    { id: "bubble-tea", from: "Bubble tea", to: "unsweetened tea, or ask for less sweet" },
    { id: "economy-rice", from: "Economy rice with fried dishes", to: "steamed and vegetable dishes" },
    { id: "nasi-padang", from: "Nasi padang with rendang", to: "rice with grilled fish and vegetables" },
    { id: "burger-fries", from: "Burger and fries", to: "a wholemeal wrap with salad" },
    { id: "fried-hor-fun", from: "Fried hor fun", to: "sliced fish soup with brown rice" },
    { id: "roast-duck-rice", from: "Roast duck rice", to: "roast duck rice, skin off, more greens" },
    { id: "creamy-pasta", from: "Creamy pasta", to: "tomato-based pasta with vegetables" },
    { id: "dry-prawn-noodles", from: "Dry prawn noodles", to: "prawn noodle soup with more vegetables" },
    { id: "satay", from: "Satay with lots of peanut sauce", to: "satay, peanut sauce on the side" },
    { id: "iced-lemon-tea", from: "Sweetened iced lemon tea", to: "plain water with a slice of lemon" },
    { id: "mee-rebus", from: "Mee rebus", to: "mee rebus with less gravy" },
    { id: "oyster-omelette", from: "Oyster omelette", to: "steamed egg with vegetables" },
    { id: "fish-and-chips", from: "Fish and chips", to: "grilled fish with vegetables" },
    { id: "ayam-penyet", from: "Ayam penyet", to: "grilled chicken with rice and vegetables" },
    { id: "rojak", from: "Rojak with sweet sauce", to: "rojak with the sauce on the side" },
    { id: "kway-chap", from: "Kway chap with braised skin", to: "kway chap with lean meat and tofu" },
  ]),
  DINNER: Object.freeze([
    { id: "white-rice", from: "White rice", to: "brown rice or half-half rice" },
    { id: "sweet-sour-pork", from: "Sweet and sour pork", to: "steamed fish" },
    { id: "fried-rice", from: "Fried rice", to: "brown rice with stir-fried vegetables" },
    { id: "coconut-curry", from: "Curry with coconut milk", to: "clear soup dishes" },
    { id: "dry-bak-chor-mee", from: "Dry bak chor mee", to: "fishball noodle soup with more vegetables" },
    { id: "fried-chicken-wings", from: "Fried chicken wings", to: "baked chicken" },
    { id: "murtabak", from: "Murtabak", to: "chapati with dhal" },
    { id: "laksa", from: "Laksa", to: "clear soup noodles with more vegetables" },
    { id: "pizza", from: "Pizza", to: "a wholemeal wrap with vegetables" },
    { id: "cereal-prawns", from: "Cereal prawns", to: "steamed prawns" },
    { id: "salted-egg-chicken", from: "Salted egg chicken", to: "ginger-steamed chicken" },
    { id: "instant-noodles", from: "Instant noodles", to: "noodle soup with vegetables and egg" },
    { id: "fried-tofu", from: "Deep-fried tofu", to: "steamed tofu" },
    { id: "claypot-rice", from: "Claypot rice", to: "brown rice with steamed chicken and greens" },
    { id: "ice-cream", from: "Ice cream", to: "a small bowl of chilled apple or pear" },
    { id: "fried-spring-rolls", from: "Fried spring rolls", to: "fresh popiah" },
    { id: "fried-ngoh-hiang", from: "Fried ngoh hiang", to: "yong tau foo, non-fried pieces" },
    { id: "potato-chips", from: "Potato chips", to: "plain popcorn" },
    { id: "ice-kacang", from: "Ice kacang", to: "a small bowl of guava or apple" },
    { id: "chendol", from: "Chendol", to: "a small bowl of chilled guava or pear" },
    { id: "bubur-cha-cha", from: "Bubur cha cha", to: "red bean soup with less sugar" },
    { id: "supper-biscuits", from: "Supper biscuits", to: "a small handful of unsalted nuts" },
    { id: "bandung", from: "Bandung", to: "plain water" },
    { id: "teh-peng", from: "Teh peng", to: "teh-c kosong peng" },
  ]),
});
