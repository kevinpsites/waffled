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

// A name can match several pantry rows at once ("Butter" is a token-subset of both
// "Butter" and "Peanut butter"). Which one the badge NAMES is user-visible, so it must
// be the best candidate — not whichever row Postgres happened to return first.
describe('matchNames — picks the best pantry row, not the first', () => {
  const onHand = (...names: string[]): PantryOnHand[] =>
    names.map((name) => ({ hit: { name, amount: '1', unit: '' }, tok: tokens(name) }))

  it('prefers the exact name over a more specific one', () => {
    expect(matchNames(onHand('Peanut butter', 'Butter'), ['Butter']).get('butter')?.name).toBe('Butter')
  })

  it('prefers the exact name regardless of pantry row order', () => {
    expect(matchNames(onHand('Butter', 'Peanut butter'), ['Butter']).get('butter')?.name).toBe('Butter')
  })

  it('prefers the closest match when none is exact', () => {
    // "Chicken" against "Chicken breast" (1 extra token) and "Boneless chicken breast
    // tenderloin" (3 extra) — the tighter one is the more useful thing to show.
    const hits = matchNames(onHand('Boneless chicken breast tenderloin', 'Chicken breast'), ['Chicken'])
    expect(hits.get('chicken')?.name).toBe('Chicken breast')
  })

  it('still reports the only match it has, however loose', () => {
    // We are NOT dropping generic matches — a lone "Peanut butter" is still surfaced,
    // because the badge names it and the cook can judge. Ranking changes which row
    // wins, never whether there is one.
    expect(matchNames(onHand('Peanut butter'), ['Butter']).get('butter')?.name).toBe('Peanut butter')
  })

  it('leaves an unmatched name out of the map entirely', () => {
    expect(matchNames(onHand('Butter'), ['Leeks']).has('leeks')).toBe(false)
  })
})
