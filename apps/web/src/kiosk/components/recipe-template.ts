// The blessed Markdown recipe format — the single source of truth for the editor's
// "paste markdown" helpers (Use template / See example). The same format the
// `parse-markdown` endpoint (and the dev/seed import CLI) understands. Documented in
// docs/RECIPE_FORMAT.md.

export const RECIPE_TEMPLATE = `---
type: dinner
protein: chicken
cuisine: Italian
effort: weeknight
dietary: [gluten-free]
vegetables: [spinach]
tags: [family-favorite]
---

# Recipe title

*4 servings*

## Ingredients

### Section name
- 1 lb main ingredient, prepped
- 2 tbsp something

## Instructions

1. First step.
2. Second step.

## Notes

Anything worth remembering.
Source: where it came from
`

export const RECIPE_EXAMPLE = `---
type: dinner
protein: chicken
base: noodle
cuisine: Italian
effort: weeknight
cook_method: stovetop
dietary: [gluten-free]
vegetables: [spinach, tomato]
tags: [family-favorite, quick]
---

# Chicken Parmesan

*4 servings*

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
2. Pan-fry until golden, about 4 minutes a side.
3. Top with sauce and cheese, broil until bubbly.

## Notes

Kids like it with extra cheese.
Source: Grandma's kitchen
`
