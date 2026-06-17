// Shared grocery aisle classification + pantry-staple detection. Used by the
// recipe importer (to tag ingredients at import time) and by the grocery list
// (to file items into aisle sections and keep staples off the list). Keeping it
// in one place means the importer and the live list always agree.

const AISLES: Array<[RegExp, string]> = [
  // shelf-stable forms first, so "diced/canned/dried <produce>" → Pantry not Produce
  [/\b(diced tomato|crushed tomato|canned tomato|can tomato|tomato paste|tomato sauce|can of|coconut milk|marinara|pesto|broth|stock|sauce|dried|flake|ground |powder|paste|seasoning|oregano|cumin|paprika|cayenne|spice|sriracha|ketchup|mustard|mayo|mayonnaise|hoisin|salsa|relish|jam|jelly|syrup|peanut butter)/i, 'Pantry'],
  [/\b(spinach|kale|lettuce|arugula|tomato|onion|shallot|scallion|garlic|basil|cilantro|parsley|herb|lemon|lime|zucchini|mushroom|bell pepper|broccoli|carrot|celery|pea|ginger|potato|cucumber|avocado|chili|jalape|corn|squash|leek|cabbage|pineapple|apple|banana|berr|strawberr|blueberr|mango|grape|melon|orange|peach|pear|lettuce|sprout)/i, 'Produce'],
  [/\b(cheese|parmesan|parmigiano|mozzarella|cotija|ricotta|feta|cream|crème|cr[eè]me fra[iî]che|milk|butter|yogurt|egg|ravioli|tortellini|half[- ]and[- ]half)/i, 'Dairy & Chilled'],
  [/\b(chicken|sausage|chorizo|salmon|shrimp|prawn|beef|steak|pork|bacon|turkey|fish|cod|tilapia|ground )/i, 'Meat & Seafood'],
  [/\b(bread|breadcrumb|panko|baguette|bun|roll)/i, 'Bakery'],
  [/\b(frozen)/i, 'Frozen'],
  [/\b(pasta|linguine|penne|spaghetti|noodle|lasagne|lasagna|rigatoni|fettuccine|macaroni|oil|vinegar|flour|sugar|rice|lentil|bean|chickpea|salt|pepper|honey|tortilla|wine|soy)/i, 'Pantry'],
]
// canned/jarred forms are pantry regardless of the produce inside
const CANNED_UNITS = new Set(['can', 'cans', 'jar', 'jars'])

export function aisleFor(name: string, unit?: string | null): string {
  if (unit && CANNED_UNITS.has(unit.toLowerCase())) return 'Pantry'
  for (const [re, aisle] of AISLES) if (re.test(name)) return aisle
  return 'Other'
}

const STAPLES = /\b(olive oil|kosher salt|sea salt|salt|black pepper|garlic|butter|rice|pasta|flour|sugar|water|parmesan|parmigiano)\b/i

export function isStaple(name: string): boolean {
  // "red pepper flakes" / "dried oregano" are seasonings, not pantry staples
  if (/flake|oregano|paprika|cumin|cayenne/i.test(name)) return false
  return STAPLES.test(name)
}
