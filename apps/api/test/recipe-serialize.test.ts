import { describe, it, expect } from 'vitest'
import { serializeRecipe, formatDuration, recipeFilename } from '../src/modules/meals/recipe-serialize'
import { parseRecipe } from '../src/modules/meals/recipe-markdown'

// A fully-populated recipe detail in the shape the GET /api/recipes/:id route returns
// ({ recipe, ingredients, steps }). Serializing it should produce the blessed markdown
// format and round-trip back through parseRecipe with the same structure.
const DETAIL = {
  recipe: {
    title: 'Chicken Parmesan',
    emoji: '🍗',
    servings: 4,
    prepTimeMinutes: 15,
    cookTimeMinutes: 25,
    tags: ['family-favorite', 'quick'],
    mealType: 'dinner',
    protein: 'chicken',
    base: 'noodle',
    cuisine: 'Italian',
    effort: 'weeknight',
    cookMethod: 'stovetop',
    flavorProfile: 'savory',
    dietary: ['gluten-free'],
    vegetables: ['spinach', 'tomato'],
    notes: 'Kids like it with extra cheese.',
    sourceName: "Grandma's kitchen",
  },
  ingredients: [
    { name: 'chicken breasts', amount: 2, unit: null, prepNote: 'pounded thin', display: '2 chicken breasts, pounded thin', section: 'Chicken' },
    { name: 'breadcrumbs', amount: 1, unit: 'cup', prepNote: null, display: '1 cup breadcrumbs', section: 'Chicken' },
    { name: 'marinara', amount: 2, unit: 'cups', prepNote: null, display: '2 cups marinara', section: 'Sauce' },
    { name: 'mozzarella', amount: 1, unit: 'cup', prepNote: 'shredded', display: '1 cup mozzarella, shredded', section: 'Sauce' },
  ],
  steps: [
    { stepNumber: 1, instruction: 'Bread the chicken: dredge in egg, then breadcrumbs.', ingredients: ['2 eggs', '1 cup breadcrumbs'], timerSeconds: null },
    { stepNumber: 2, instruction: 'Pan-fry until golden, about a side.', ingredients: [], timerSeconds: 240 },
    { stepNumber: 3, instruction: 'Top with sauce and cheese, broil until bubbly.', ingredients: [], timerSeconds: null },
  ],
}

describe('formatDuration', () => {
  it('renders seconds as human durations that parseDuration round-trips', () => {
    expect(formatDuration(240)).toBe('4 minutes')
    expect(formatDuration(60)).toBe('1 minute')
    expect(formatDuration(3600)).toBe('1 hour')
    expect(formatDuration(5400)).toBe('1 hour 30 minutes')
    expect(formatDuration(3660)).toBe('1 hour 1 minute')
    expect(formatDuration(45)).toBe('45 seconds')
    expect(formatDuration(90)).toBe('1 minute 30 seconds')
  })

  it('returns null for zero / nullish', () => {
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(undefined)).toBeNull()
  })
})

describe('recipeFilename', () => {
  it('slugifies the title into a .md filename', () => {
    expect(recipeFilename('Chicken Parmesan')).toBe('chicken-parmesan.md')
    expect(recipeFilename('Grandma’s BEST Chili!')).toBe('grandmas-best-chili.md')
    expect(recipeFilename('   ')).toBe('recipe.md')
  })
})

describe('serializeRecipe', () => {
  const md = serializeRecipe(DETAIL)

  it('emits frontmatter, title, servings, ingredient sections, and instructions', () => {
    expect(md).toContain('type: dinner')
    expect(md).toContain('protein: chicken')
    expect(md).toContain('dietary: [gluten-free]')
    expect(md).toContain('vegetables: [spinach, tomato]')
    expect(md).toContain('tags: [family-favorite, quick]')
    expect(md).toContain('# Chicken Parmesan')
    expect(md).toContain('*4 servings')
    expect(md).toContain('### Chicken')
    expect(md).toContain('### Sauce')
    expect(md).toContain('- 2 chicken breasts, pounded thin')
    expect(md).toContain('1. Bread the chicken')
    expect(md).toContain('**Ingredients:**')
    expect(md).toContain('**Timer:** 4 minutes')
  })

  it('does not put the emoji in the H1 (parser would fold it into the title)', () => {
    expect(md).not.toContain('# 🍗')
  })

  it('round-trips through parseRecipe with the same structure', () => {
    const r = parseRecipe(md)
    expect(r.title).toBe('Chicken Parmesan')
    expect(r.servings).toBe(4)
    expect(r.tags).toEqual(['family-favorite', 'quick'])
    expect(r.mealType).toBe('dinner')
    expect(r.protein).toBe('chicken')
    expect(r.base).toBe('noodle')
    expect(r.cuisine).toBe('Italian')
    expect(r.effort).toBe('weeknight')
    expect(r.cookMethod).toBe('stovetop')
    expect(r.flavorProfile).toBe('savory')
    expect(r.dietary).toEqual(['gluten-free'])
    expect(r.vegetables).toEqual(['spinach', 'tomato'])

    expect(r.ingredients).toHaveLength(4)
    expect(r.ingredients[0].section).toBe('Chicken')
    expect(r.ingredients[0].name).toBe('chicken breasts')
    expect(r.ingredients[2].section).toBe('Sauce')
    expect(r.ingredients[2].name).toBe('marinara')

    expect(r.steps).toHaveLength(3)
    expect(r.steps[0].text).toContain('Bread the chicken')
    expect(r.steps[0].ingredients).toEqual(['2 eggs', '1 cup breadcrumbs'])
    expect(r.steps[1].timerSeconds).toBe(240)
    expect(r.steps[1].text).not.toMatch(/Timer/i)

    expect(r.notes).toContain('Kids like it')
    expect(r.sourceName).toBe("Grandma's kitchen")
  })

  it('appends a Source line under Notes when notes lacks one', () => {
    expect(md).toMatch(/## Notes[\s\S]*Source: Grandma's kitchen/)
    // exactly one Source line
    expect(md.match(/^Source:/gim) ?? []).toHaveLength(1)
  })

  it('does NOT duplicate Source when notes already contains it (imported recipes)', () => {
    const withSource = serializeRecipe({
      ...DETAIL,
      recipe: { ...DETAIL.recipe, notes: 'Kids like it with extra cheese.\nSource: Grandma\'s kitchen', sourceName: "Grandma's kitchen" },
    })
    expect(withSource.match(/^Source:/gim) ?? []).toHaveLength(1)
  })

  it('composes an ingredient line from parts when display is missing', () => {
    const out = serializeRecipe({
      recipe: { title: 'X', servings: 2 },
      ingredients: [{ name: 'mozzarella', amount: 1, unit: 'cup', prepNote: 'shredded', display: null, section: null }],
      steps: [],
    })
    expect(out).toContain('- 1 cup mozzarella, shredded')
  })

  it('omits empty sections (frontmatter, notes) for a minimal recipe', () => {
    const bare = serializeRecipe({ recipe: { title: 'Toast', servings: 1 }, ingredients: [], steps: [] })
    expect(bare).toContain('# Toast')
    // Always the plural token so a 1-serving recipe round-trips (the parser only matches
    // `\d+ servings`; "*1 serving*" would fall back to the default 4).
    expect(bare).toContain('*1 servings*')
    expect(bare).not.toContain('type:')
    expect(bare).not.toContain('## Notes')
    // parseable, and servings survives the round-trip
    expect(parseRecipe(bare).title).toBe('Toast')
    expect(parseRecipe(bare).servings).toBe(1)
  })
})
