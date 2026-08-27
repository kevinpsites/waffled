// The pantry ↔ ingredient name matcher, and the one place a matched row is CHOSEN.
//
// `match.ts` is deliberately dumb — no stemming, no synonyms, no plurals — because it
// backs three user-visible surfaces at once (the grocery board badge, the recipe
// "on hand" banner, and Cook from your pantry). Every rule here is therefore about
// keeping that dumbness honest rather than making it clever.
import { describe, it, expect } from 'vitest'
import { tokens, matches } from '../src/modules/pantry/match'
import { matchNames, type PantryOnHand } from '../src/modules/pantry/presence'

const m = (a: string, b: string) => matches(tokens(a), tokens(b))

describe('tokens — allergen annotations are not part of the name', () => {
  // Meal-kit imports name ingredients "<thing> — contains <allergens>". Those trailing
  // words are a WARNING ABOUT the thing, not the thing, and feeding them to a subset
  // matcher is how "Cream cheese — contains milk" came to claim you have cream cheese
  // when all you own is milk.
  it('drops an em-dash "contains" suffix', () => {
    expect([...tokens('butter — contains milk')]).toEqual(['butter'])
  })

  it('drops the suffix however it was punctuated', () => {
    for (const name of [
      'butter – contains milk',   // en dash
      'butter - contains milk',   // hyphen
      'butter -- contains milk',
      'butter (contains milk)',
      'butter, contains milk',
      'butter — Contains Milk',   // case
    ]) {
      expect([...tokens(name)], name).toEqual(['butter'])
    }
  })

  it('drops every listed allergen, not just the first', () => {
    expect([...tokens('flour — contains gluten/wheat')]).toEqual(['flour'])
    expect([...tokens('packet sesame dressing — contains sesame, soy')].sort()).toEqual(['dressing', 'packet', 'sesame'])
  })

  it('keeps the name when there is nothing but the annotation', () => {
    // Stripping to an empty token set would make the row match NOTHING, silently.
    // Better to leave a weird name weird than to erase it.
    expect(tokens('contains milk').size).toBeGreaterThan(0)
  })

  it('leaves an ordinary name alone', () => {
    expect([...tokens('milk')]).toEqual(['milk'])
    expect([...tokens('Whole milk')]).toEqual(['milk'])
  })
})

describe('matches — the false positives the annotation caused', () => {
  it('no longer claims milk is cream cheese', () => {
    expect(m('Cream cheese — contains milk', 'Whole milk')).toBe(false)
    expect(m('packet sour cream — contains milk', 'Whole milk')).toBe(false)
  })

  it('no longer claims eggs are mayonnaise', () => {
    expect(m('mayonnaise — contains eggs', 'Eggs')).toBe(false)
  })

  it('no longer claims flour is pasta', () => {
    expect(m('Linguine pasta — contains wheat', 'Flour')).toBe(false)
  })

  it('still matches when the match was real all along', () => {
    // The suffix only ever ADDED tokens, so stripping it can only remove matches that
    // were wrong. These have to survive to prove we removed the right ones.
    expect(m('Soy sauce — contains soy', 'Soy sauce')).toBe(true)
    expect(m('Cream cheese — contains milk', 'Cream cheese')).toBe(true)
    expect(m('Shredded Parmesan — contains milk', 'Parmesan')).toBe(true)
  })
})

describe('matches — the documented behavior stays put', () => {
  it('matches across word order and subsets', () => {
    expect(m('ground beef', 'beef, ground')).toBe(true)
    expect(m('Chicken', 'Chicken breast')).toBe(true)
  })

  it('does not match a mere prefix', () => {
    expect(m('egg', 'eggplant')).toBe(false)
  })

  it('never matches an empty token set', () => {
    expect(m('a', 'Chicken')).toBe(false)
  })
})

// A name can match several pantry rows at once ("Chicken" is a token-subset of both
// "Chicken" and "Chicken breast"). Which one the badge NAMES is user-visible, so it must
// be the best candidate — not whichever row Postgres happened to return first.
// (These used to be posed as Butter / Peanut butter. That pair now yields exactly ONE
// candidate — see the modifier rule above — so it would have gone green while testing
// nothing. Chicken/Chicken breast is the same shape with two live candidates.)
describe('matchNames — picks the best pantry row, not the first', () => {
  const onHand = (...names: string[]): PantryOnHand[] =>
    names.map((name) => ({ hit: { name, amount: '1', unit: '' }, tok: tokens(name) }))

  it('prefers the exact name over a more specific one', () => {
    expect(matchNames(onHand('Chicken breast', 'Chicken'), ['Chicken']).get('chicken')?.name).toBe('Chicken')
  })

  it('prefers the exact name regardless of pantry row order', () => {
    expect(matchNames(onHand('Chicken', 'Chicken breast'), ['Chicken']).get('chicken')?.name).toBe('Chicken')
  })

  it('prefers the closest match when none is exact', () => {
    // "Chicken" against "Chicken breast" (1 extra token) and "Boneless chicken breast
    // tenderloin" (3 extra) — the tighter one is the more useful thing to show.
    const hits = matchNames(onHand('Boneless chicken breast tenderloin', 'Chicken breast'), ['Chicken'])
    expect(hits.get('chicken')?.name).toBe('Chicken breast')
  })

  it('still reports the only match it has, however loose', () => {
    // We are NOT dropping generic matches — a lone "Chicken breast" still answers
    // "Chicken", because the badge names it and the cook can judge. Ranking changes
    // which row wins, never whether there is one. Only the MODIFIERS list drops
    // candidates outright, and it does that in matches(), not here.
    expect(matchNames(onHand('Chicken breast'), ['Chicken']).get('chicken')?.name).toBe('Chicken breast')
  })

  it('leaves an unmatched name out of the map entirely', () => {
    expect(matchNames(onHand('Butter'), ['Leeks']).has('leeks')).toBe(false)
  })
})

// The subset rule's worst failure mode: a GENERAL name landing on a pantry item that is
// a different food entirely. "butter" ⊂ "peanut butter" and "milk" ⊂ "evaporated milk"
// are structurally identical to "chicken" ⊂ "chicken breast" — the token shapes cannot
// tell them apart, so nothing here can be a token-level rule. It has to be a list.
describe('matches — type-changing modifiers are not narrowing words', () => {
  it('does not claim peanut butter is butter', () => {
    // The single most common false positive in the live data: butter is in most recipes,
    // so one jar of peanut butter used to light up ~15 of them at once.
    expect(m('butter', 'Peanut butter')).toBe(false)
    expect(m('Peanut butter', 'butter')).toBe(false)
  })

  it('does not claim milk is evaporated milk, whichever side is longer', () => {
    // "Whole milk" reduces to {milk} — `whole` is a stopword — so here the INGREDIENT is
    // the longer side. The rule is about where the modifier sits, not which argument.
    expect(m('evaporated milk', 'Whole milk')).toBe(false)
    expect(m('Whole milk', 'evaporated milk')).toBe(false)
    expect(m('sweetened condensed milk', 'milk')).toBe(false)
  })

  it('covers the other milks that are not milk', () => {
    for (const impostor of ['Almond milk', 'Cashew milk', 'Coconut milk', 'Soy milk', 'Oat milk', 'Hemp milk', 'Vegan milk']) {
      expect(m('milk', impostor), impostor).toBe(false)
    }
  })

  it('still matches when the modifier is on BOTH sides', () => {
    // A listed word is only disqualifying when it is the DIFFERENCE between the names.
    expect(m('Peanut butter', 'Peanut butter')).toBe(true)
    expect(m('Soy sauce', 'Soy sauce')).toBe(true)
    expect(m('soy sauce', 'Sauce, soy')).toBe(true)
    expect(m('Coconut milk', 'coconut milk')).toBe(true)
  })

  it('leaves genuine narrowing words alone', () => {
    // These are the same shape as butter/peanut butter and MUST keep matching — which is
    // exactly why the fix is a curated list and not "a short name can't match a long one".
    expect(m('Peas', 'Frozen peas')).toBe(true)
    expect(m('Chicken', 'Chicken breast')).toBe(true)
    expect(m('flour', 'All-purpose flour')).toBe(true)
  })

  it('does not let a bare modifier word stand in for the food it modifies', () => {
    // The hole the "both sides" rule left open: when the SHORT name is nothing but the
    // modifier, the modifier is on both sides, so it is never "the difference" and the
    // guard above never fires — while the word that IS the difference (oil, milk, sauce)
    // is not itself listed. A bag of shredded coconut then answers for coconut milk.
    // Worse than a wrong badge: this feeds the picker's pre-uncheck, so the ingredient
    // silently never reaches the list and the shopper comes home without it.
    expect(m('Coconut', 'Coconut milk')).toBe(false)
    expect(m('Coconut', 'Coconut oil')).toBe(false)
    expect(m('Almond', 'Almond milk')).toBe(false)
    expect(m('Soy', 'Soy sauce')).toBe(false)
    expect(m('Oat', 'Oat milk')).toBe(false)
    expect(m('Peanut', 'Peanut butter')).toBe(false)
    // Symmetric — the rule is about set size, not argument order.
    expect(m('Coconut milk', 'Coconut')).toBe(false)
  })

  it('still rejects an unshared modifier when the short name has several words', () => {
    // Guards the ORDER of the two rules. The bare-modifier rule returns early on the
    // first ordinary word in the short name, which would skip the unshared-modifier
    // check if it ever ran first. It doesn't today — the loop above returns false before
    // control gets there — and this pins that, so reordering the guards fails loudly
    // instead of quietly re-opening the butter/peanut-butter hole.
    expect(m('butter cups', 'Peanut butter cups')).toBe(false)
    expect(m('cream cheese', 'Vegan cream cheese')).toBe(false)
    expect(m('condensed milk', 'Sweetened condensed milk')).toBe(false)
  })

  it('still matches a bare modifier against itself', () => {
    // The above must not cost the honest case: coconut IS coconut. Only a name that adds
    // a food word on one side is rejected, so equal token sets always survive.
    expect(m('Coconut', 'coconut')).toBe(true)
    expect(m('Soy', 'soy')).toBe(true)
  })

  it('does not accidentally match two different modified foods', () => {
    // Neither is a subset of the other, so this never reached the new rule — asserted so
    // a future "smarter" matcher cannot quietly start claiming it.
    expect(m('Soy sauce', 'Soy milk')).toBe(false)
    expect(m('Almond milk', 'Coconut milk')).toBe(false)
  })
})
