import { describe, it, expect } from 'vitest'
import { parseRecipe, parseIngredient, parseAmount, parseDuration } from '../src/modules/meals/recipe-markdown'

const SAMPLE = `---
type: dinner
protein: chicken
base: noodle
cuisine: Italian
effort: weeknight
cook_method: stovetop
flavor_profile: savory
dietary: [gluten-free]
vegetables: [spinach, tomato]
tags: [family-favorite, quick]
---

# Chicken Parmesan

*4 servings | 600 cal*

## Ingredients

### Chicken
- 2 chicken breasts, pounded thin
- 1 cup breadcrumbs
- 2 eggs, beaten

### Sauce
- 2 cups marinara
- 1 cup mozzarella, shredded

## Instructions

1. Bread the chicken: dredge in egg, then breadcrumbs.
   **Ingredients:**
   - 2 eggs
   - 1 cup breadcrumbs
2. Pan-fry until golden, about 4 minutes a side.
   **Timer:** 4 minutes
3. Top with sauce and cheese, broil until bubbly.

## Notes

Kids like it with extra cheese.
Source: Grandma's kitchen
`

describe('parseDuration', () => {
  it('parses minutes, hours, seconds, compound, and short forms', () => {
    expect(parseDuration('20 minutes')).toBe(1200)
    expect(parseDuration('1 hour 30 min')).toBe(5400)
    expect(parseDuration('90s')).toBe(90)
    expect(parseDuration('2 hrs')).toBe(7200)
    expect(parseDuration('45 sec')).toBe(45)
    expect(parseDuration('1h')).toBe(3600)
    expect(parseDuration('1.5 hours')).toBe(5400)
    expect(parseDuration('nonsense')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })
})

describe('parseAmount', () => {
  it('parses whole, decimal, fraction, mixed-unicode, and ranges', () => {
    expect(parseAmount('2')).toBe(2)
    expect(parseAmount('1.5')).toBe(1.5)
    expect(parseAmount('1/2')).toBe(0.5)
    expect(parseAmount('½')).toBe(0.5)
    expect(parseAmount('4½')).toBe(4.5)
    expect(parseAmount('2-3')).toBe(2)
    expect(parseAmount('salt')).toBeNull()
  })
})

describe('parseIngredient', () => {
  it('splits amount, unit, name, and prep note + tags an aisle', () => {
    const ing = parseIngredient('1 cup mozzarella, shredded', 'Sauce')
    expect(ing.amount).toBe(1)
    expect(ing.unit).toBe('cup')
    expect(ing.name).toBe('mozzarella')
    expect(ing.prepNote).toBe('shredded')
    expect(ing.section).toBe('Sauce')
    expect(ing.aisle).toBeTruthy()
    expect(typeof ing.isStaple).toBe('boolean')
  })

  it('drops a parenthetical size from the name but keeps display', () => {
    const ing = parseIngredient('1 can (15 oz.) black beans', null)
    expect(ing.name).toBe('black beans')
    expect(ing.display).toBe('1 can (15 oz.) black beans')
  })

  it('strips a leading size word that is not a unit', () => {
    expect(parseIngredient('1 large sweet onion', null).name).toBe('sweet onion')
  })

  it('keeps a leading-modifier name whole, splitting after the noun', () => {
    // Regression: the old first-comma split collapsed this to name "boneless".
    const ing = parseIngredient('3 boneless, skinless chicken breast halves, cut into 1-inch pieces', null)
    expect(ing.name).toBe('boneless, skinless chicken breast halves')
    expect(ing.prepNote).toBe('cut into 1-inch pieces')
  })

  it('still splits a normal name from its prep note at the first comma', () => {
    const ing = parseIngredient('3 scallions, whites and greens separated', null)
    expect(ing.name).toBe('scallions')
    expect(ing.prepNote).toBe('whites and greens separated')
  })
})

describe('parseRecipe', () => {
  const r = parseRecipe(SAMPLE, 'Weeknight')

  it('reads the title, servings, and collection', () => {
    expect(r.title).toBe('Chicken Parmesan')
    expect(r.servings).toBe(4)
    expect(r.collection).toBe('Weeknight')
  })

  it('reads frontmatter metadata', () => {
    expect(r.mealType).toBe('dinner')
    expect(r.protein).toBe('chicken')
    expect(r.base).toBe('noodle')
    expect(r.cuisine).toBe('Italian')
    expect(r.effort).toBe('weeknight')
    expect(r.cookMethod).toBe('stovetop')
    expect(r.flavorProfile).toBe('savory')
    expect(r.dietary).toEqual(['gluten-free'])
    expect(r.vegetables).toEqual(['spinach', 'tomato'])
    expect(r.tags).toEqual(['family-favorite', 'quick'])
  })

  it('parses sectioned ingredients', () => {
    expect(r.ingredients).toHaveLength(5)
    expect(r.ingredients[0].section).toBe('Chicken')
    expect(r.ingredients[3].section).toBe('Sauce')
    expect(r.ingredients[3].name).toBe('marinara')
  })

  it('parses numbered steps with per-step ingredient blocks', () => {
    expect(r.steps).toHaveLength(3)
    expect(r.steps[0].text).toContain('Bread the chicken')
    expect(r.steps[0].ingredients).toEqual(['2 eggs', '1 cup breadcrumbs'])
    expect(r.steps[1].ingredients).toEqual([])
  })

  it('parses a **Timer:** sub-line into timerSeconds and strips it from the text', () => {
    expect(r.steps[1].timerSeconds).toBe(240)
    expect(r.steps[1].text).toContain('Pan-fry until golden')
    expect(r.steps[1].text).not.toMatch(/Timer/i)
    expect(r.steps[1].text).not.toContain('4 minutes\n')
  })

  it('leaves timerSeconds undefined for a step with no timer', () => {
    expect(r.steps[0].timerSeconds).toBeUndefined()
    expect(r.steps[2].timerSeconds).toBeUndefined()
  })

  it('parses various durations and an inline {timer: …} token', () => {
    const md = `# T\n\n## Instructions\n\n1. Rest the dough. {timer: 1 hour 30 min}\n2. Simmer.\n   **Timer:** 90s\n`
    const parsed = parseRecipe(md)
    expect(parsed.steps[0].timerSeconds).toBe(5400)
    expect(parsed.steps[0].text).toBe('Rest the dough.')
    expect(parsed.steps[1].timerSeconds).toBe(90)
  })

  it('auto-detects a duration written in the step prose (no explicit marker)', () => {
    // Real photo/voice recipes phrase timings in the sentence ("cook for 6 minutes")
    // rather than as a **Timer:** line. Attach a timer from the prose, and keep the
    // duration visible in the step (it is real instruction text, not markup).
    const md = `# Grilled Pork Chops\n\n## Instructions\n\n1. Sprinkle salt on each chop.\n2. Place on the grill and cook for 6 minutes.\n3. Flip and cook for another 6 minutes.\n4. Remove and let them rest for 2 minutes.\n`
    const p = parseRecipe(md)
    expect(p.steps[0].timerSeconds).toBeUndefined() // no duration in prose
    expect(p.steps[1].timerSeconds).toBe(360)
    expect(p.steps[1].text).toContain('cook for 6 minutes') // not stripped
    expect(p.steps[2].timerSeconds).toBe(360)
    expect(p.steps[3].timerSeconds).toBe(120)
  })

  it('an explicit **Timer:** overrides a different duration in the prose', () => {
    const md = `# T\n\n## Instructions\n\n1. Simmer for 5 minutes, stirring.\n   **Timer:** 20 minutes\n`
    const p = parseRecipe(md)
    expect(p.steps[0].timerSeconds).toBe(1200) // the marker wins, not the prose "5 minutes"
  })

  it('takes the FIRST prose duration, not the sum, when a step lists several', () => {
    const md = `# T\n\n## Instructions\n\n1. Bake 20 minutes, then rest 5 minutes.\n`
    const p = parseRecipe(md)
    expect(p.steps[0].timerSeconds).toBe(1200) // 20 min, not 25
  })

  it('extracts notes and the source name', () => {
    expect(r.notes).toContain('Kids like it')
    expect(r.sourceName).toBe("Grandma's kitchen")
  })

  it('defaults to 4 servings and Untitled when absent', () => {
    const bare = parseRecipe('Just some text with no headings')
    expect(bare.title).toBe('Untitled')
    expect(bare.servings).toBe(4)
    expect(bare.ingredients).toEqual([])
    expect(bare.steps).toEqual([])
    expect(bare.collection).toBeNull()
  })
})
