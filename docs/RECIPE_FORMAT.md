# Recipe Markdown format

Waffled recipes can be written in a small Markdown format. You can paste a recipe in
this format directly into the app — **Recipes → ＋ New recipe → 📋 Paste markdown** —
and Waffled parses it into a structured recipe (title, metadata, ingredients grouped by
section, numbered steps) that you then review and save.

It's also handy for generating recipes with an LLM: paste the template below into
ChatGPT/Claude, ask it to fill in a dish, and paste the result back into Waffled.

The same format is what the **Share** action on a recipe produces — Waffled compiles any
recipe in your library into this Markdown and hands it to your device's share sheet (as a
`.md` file on iPhone/iPad, or clipboard/download on the web). A shared recipe pastes
straight back into another Waffled library, so import and export are the same format.

> **You usually don't need to do this by hand.** The New recipe screen can build a
> recipe *for* you from a **photo** of a physical recipe or a spoken/typed
> **description** — both use this same format under the hood and drop into the editor
> for review. See the "Add a recipe from a photo or your voice" guide.

> The same format powers the dev-only `import-recipes` seeding CLI, but you never need
> the CLI — authoring and pasting in-app is the supported path.

## Structure

```markdown
---
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
   **Timer:** 4 minutes
3. Top with sauce and cheese, broil until bubbly.

## Notes

Kids like it with extra cheese.
Source: Grandma's kitchen
```

## Frontmatter (the `---` block)

All fields are optional. Use `none` (or omit) when a field doesn't apply.

| Field | Meaning | Example |
| --- | --- | --- |
| `type` | meal type | `dinner`, `breakfast`, `side`, `dessert` |
| `protein` | main protein | `chicken`, `beef`, `tofu` |
| `base` | starch/base | `rice`, `noodle`, `potato` |
| `cuisine` | cuisine | `Italian`, `Thai`, `Mexican` |
| `effort` | rough effort | `weeknight`, `weekend` |
| `cook_method` | how it's cooked | `oven`, `stovetop`, `sheet-pan` |
| `flavor_profile` | flavor note | `savory`, `spicy` |
| `dietary` | dietary tags (list) | `[vegetarian, gluten-free]` |
| `vegetables` | vegetables featured (list) | `[spinach, tomato]` |
| `tags` | free-form tags (list) | `[family-favorite, quick]` |

These power the Recipes library's search, filters, and chips.

## Body

- **`# Title`** — the recipe name (first H1).
- **`*N servings*`** — sets the serving count (defaults to 4 if omitted). Extra text
  after a `|` (e.g. `*4 servings | 600 cal*`) is ignored.
- **`## Ingredients`** — bullet list. Optional **`### Section`** headings group
  ingredients (e.g. *Chicken* / *Sauce*). Each bullet is parsed into amount, unit,
  name, and a prep note after a comma:
  - `2 cups marinara` → 2 / cups / marinara
  - `1 cup mozzarella, shredded` → 1 / cup / mozzarella / *shredded*
  - `Kosher salt, to taste` → name "Kosher salt", note "to taste"
  - Amounts can be whole, decimal, fractions (`1/2`, `½`, `4½`), or a range (`2-3`).
  - Each ingredient is auto-tagged with a grocery aisle so the grocery auto-build can
    group and dedupe it.
- **`## Instructions`** — a numbered list (`1.`, `2.`, …). Each step may include a
  per-step ingredient sub-list under a `**Ingredients:**` line:
  ```markdown
  1. Bread the chicken.
     **Ingredients:**
     - 2 eggs
     - 1 cup breadcrumbs
  ```
  A step can also declare a **timer** — the cook-mode timer for that step — with a
  `**Timer:**` sub-line (mirrors `**Ingredients:**`). The duration is written in plain
  language and parsed into seconds; the markup is stripped from the displayed step:
  ```markdown
  2. Pan-fry until golden, about 4 minutes a side.
     **Timer:** 4 minutes
  ```
  Durations accept minutes/hours/seconds and compound/short forms — `20 minutes`,
  `1 hour 30 min`, `1.5 hrs`, `90s`. You can also drop the timer inline as
  `{timer: 20 minutes}` anywhere in the step text (equivalent; also stripped).

  You often don't need the marker at all: if a step **sentence** states a time
  (`Place on the grill and cook for 6 minutes.`), that duration is auto-detected and a
  timer is attached — the wording stays in the step. An explicit `**Timer:**` /
  `{timer:}` always wins over the prose, and when a step mentions two times the first
  one is used.
- **`## Notes`** — free text. A `Source: …` line is captured as the recipe's source.

## After you paste

Parsing fills the editor — nothing is saved until you press **Create recipe**. Review
the metadata, ingredient rows, and steps, fix anything the parser got wrong, then save.
