# Waffled web app — conventions & gotchas (`apps/web`, React/kiosk)

Folder-scoped notes; loads when working under `apps/web`. See the repo-root
`CLAUDE.md` for repo-wide workflow (worktree-first, TDD, PRs, releases).

## Web app (React/kiosk, `apps/web`)

### Design system — REUSE, don't hand-roll (this bit us — polish it once, use it everywhere)

**Two hard rules for any web UI you build:**
1. **Always match the app's visual style** — use the existing design-system classes/
   components. Never ship raw/base HTML controls (bare `<input type="number">`,
   default `<button>`, un-backdropped divs). If it looks like an unstyled browser
   default, it's wrong.
2. **Reuse the component/pattern that already exists** before writing a new one. If a
   modal/button/toggle/timer already exists, use it — don't reinvent a worse copy.

The shared vocabulary (grep these before hand-rolling):
- **Modals:** there's no `<Modal>` wrapper — the pattern is `.modal-overlay` (fixed,
  backdrop, centers its child) wrapping `.modal-card` (white rounded card) + a
  `.modal-close` × button. Copy `components/ListsModal.tsx` / `ChoreModal.tsx`. (A
  bare `.modal`/`.modal-backdrop` are **undefined** — using them = an un-centered,
  unstyled mess.) CSS: `styles/kiosk.css`.
- **Buttons:** `className="btn btn-primary"` (purple primary — **both** classes; `btn`
  alone or `btn-primary` alone loses the pill), `btn btn-ghost` (secondary/Cancel),
  `btn-ai` (gradient). CSS: `styles/waffled.css`.
- **Toggle:** the `.toggle` pill (`<span className={`toggle ${on?'on':''}`}>` inside a
  label) — not a raw checkbox. See `Settings.tsx`.
- **Labeled inputs in modals:** the `.field` / `.field-row` pattern (`styles/kiosk.css`).
  Pill selects use `.sel`.
- **Settings cards:** plain white card = `.set-card`. `.set-tray` is the *darker beige*
  group wrapper — only use it to intentionally group multiple cards; a lone card should
  not be wrapped in a tray.
- **Cook-mode / recipe timers:** the good timer-input pattern is `StepTimerControl` in
  `RecipeEditor.tsx` with `.re-timer-*` CSS (`styles/recipe.css`); the running-timer
  dock uses `.cm-timer-*` (`styles/cookmode.css`).
- **Meal placeholders** (leftovers / eating out / try-new) are `recipe_id NULL` rows
  whose `title` is regex-classified in `components/MealsColumn.tsx` and rendered as
  cards in `components/RecipeBrowser.tsx` — clone an existing card, don't invent a type.

**Verify front-end work by driving the running kiosk with Playwright (token +
screenshot) before calling it done** — a green unit test doesn't catch "looks like
unstyled HTML." (See the memory note of the same name.)
