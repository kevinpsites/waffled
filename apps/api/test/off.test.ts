// Open Food Facts normalizer — pure mapping from the OFF v3 `product` object to
// our snapshot shape (no DB / network).
import { describe, it, expect } from 'vitest'
import { normalizeOffProduct } from '../src/modules/pantry/off'

const NUTELLA = {
  product_name: 'Nutella',
  brands: 'Nutella, Ferrero',
  quantity: '950 g',
  serving_size: '15 g',
  image_front_url: 'https://img/front.jpg',
  image_url: 'https://img/other.jpg',
  allergens_tags: ['en:milk', 'en:nuts', 'en:soybeans', 'en:gluten'],
  traces_tags: ['en:peanuts', 'en:milk'],
  ingredients_analysis_tags: ['en:palm-oil', 'en:non-vegan', 'en:vegetarian'],
  nutriscore_grade: 'e',
  nova_group: 4,
  nutriments: {
    'energy-kcal_100g': 539, 'energy-kcal_serving': 81,
    proteins_100g: 6.3, proteins_serving: 0.9,
    fat_100g: 30.9, fat_serving: 4.6,
    carbohydrates_100g: 57.5, carbohydrates_serving: 8.6,
    sodium_100g: 0.0428, sodium_serving: 0.006,
  },
}

describe('normalizeOffProduct', () => {
  it('maps name/brand/image/quantity and prefers per-serving nutrition', () => {
    const v = normalizeOffProduct('3017620422003', NUTELLA)
    expect(v.name).toBe('Nutella')
    expect(v.brand).toBe('Nutella') // first brand only
    expect(v.imageUrl).toBe('https://img/front.jpg') // front preferred
    expect(v.quantityText).toBe('950 g')
    expect(v.servingBasis).toBe('per 15 g')
    // per-serving values, sodium grams → mg
    expect(v.nutrition).toEqual({ calories: 81, protein_g: 0.9, fat_g: 4.6, carbs_g: 8.6, sodium_mg: 6 })
    expect(v.nutriscore).toBe('e')
    expect(v.nova).toBe(4)
  })

  it('normalizes allergen tags to the canonical set', () => {
    const v = normalizeOffProduct('x', NUTELLA)
    expect(v.allergens.sort()).toEqual(['gluten', 'milk', 'soy', 'tree_nut'])
  })

  it('maps traces ("may contain") and excludes any that are already definite allergens', () => {
    const v = normalizeOffProduct('x', NUTELLA)
    // traces_tags peanuts + milk; milk is already definite → only peanut remains
    expect(v.traces).toEqual(['peanut'])
  })

  it('extracts only positive dietary flags', () => {
    const v = normalizeOffProduct('x', NUTELLA)
    expect(v.dietary).toEqual(['vegetarian']) // non-vegan + palm-oil (not -free) excluded
    const vegan = normalizeOffProduct('x', { ...NUTELLA, ingredients_analysis_tags: ['en:vegan', 'en:vegetarian', 'en:palm-oil-free'] })
    expect(vegan.dietary.sort()).toEqual(['palm_oil_free', 'vegan', 'vegetarian'])
  })

  it('falls back to per-100g when there is no serving size', () => {
    const v = normalizeOffProduct('x', { ...NUTELLA, serving_size: '' })
    expect(v.servingBasis).toBe('per 100 g')
    expect(v.nutrition.calories).toBe(539)
    expect(v.nutrition.sodium_mg).toBe(43) // round(0.0428 * 1000)
  })
})
