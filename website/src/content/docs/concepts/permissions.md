---
title: Permissions
description: The family-hub permission & attribution model — gate, attribute, or leave open.
---

Nook is a *family* hub, not an enterprise tool. The goal is a warm shared space where
everyone — including kids — can participate, with just enough control where it actually
matters. So we deliberately **do not** gate every action behind a role. Instead we sort
every write by what it actually does.

## The rule we apply to every action

> **Does it touch currency or someone else's record? → gate it.**
> **Is it collaborative, but you'd want to know who did it? → attribute it.**
> **Neither? → leave it open.**

That single test is why the permission surface looks the way it does. Three short
rationales:

- **Gate** — some actions have real stakes (minting stars, approving a payout) or change
  *someone else's* record (logging progress on another person's goal, deleting a shared
  goal). These get a capability check. Over-gating everything else would turn a family
  fridge into an admin console, so we keep this list small and pointed.
- **Attribute** — most everyday actions are collaborative and low-stakes: a kid adding
  "cookies" to the grocery list *is the point*. Blocking it kills participation. But you'd
  still like to know who added it. So we record and surface **who did it** instead of asking
  permission. Social accountability ("Theo, again with the cookies?") without approval
  friction.
- **Leave open** — viewing a recipe, ticking your own checklist step, requesting a meal:
  no stakes, nobody else's record, nothing to attribute. These stay frictionless.

## How gating works

Gating is a **per-role capability grid**, not a hard-coded "admins only". `member_type`
(adult / teen / kid) carries the authorization; `is_admin` (the household owner) is always
a superuser. Capabilities default conservatively — **adult = on, teen/kid = off** — and the
owner can flip any cell per household in **Settings → Family & People**. The matrix lives in
`households.settings.permissions` (deep-merged over the defaults, no migration to add more).

| Capability | What it gates |
| --- | --- |
| `chore.manage` | Create chores for *others*, edit/delete chores |
| `chore.approve` | Approve/reject completed chores |
| `reward.manage` | Manage the rewards catalog, currencies, conversions |
| `reward.approve` | Approve/deny redemptions |
| `goal.manage` | Log progress *for others*, edit/delete shared or others' goals, manage goal lists |

Clients never "show, then 403". `/api/household` returns the caller's resolved
`capabilities`, and the UI renders capable affordances only.

### Carve-outs — you can always act on your own stuff

Gating never blocks acting on *yourself*. These are always allowed regardless of role:

- **Chores** — complete/claim any chore; create a chore for *yourself* or *up-for-grabs*
  (assigning it to someone else needs `chore.manage`).
- **Rewards** — redeem a reward for yourself; convert your own balance.
- **Goals** — log progress *for yourself* (or a family/shared log); create a *personal* goal
  (one with no other participants); tick a checklist step (it's self-attributed); create a
  goal list. Logging attributed to **another person**, or editing/deleting a goal that isn't
  your own sole-participant goal, needs `goal.manage`.

## How attribution works

Collaborative surfaces record the actor and surface it ambiently — no approval step.

- **Lists & groceries** — every item stores `created_by`; the UI shows **"added by {name}"**
  on manually-added items. Items generated from the meal builder are marked `source = 'auto'`
  (with the originating recipes) and render as **"🍽 from meal plan"** instead — so a kid's
  hand-added item is clearly attributed while auto-built ingredients aren't mistaken for it.
  Checking an item off records `checked_by` too.
- **Goals** — every log records `created_by` (the actor) alongside `person_id` (who the
  progress is *for*); the activity feed shows who logged what.

## What we intentionally left open

Recipes (any member can add/edit), meal planning, requesting/viewing — these are
collaborative and carry no per-person stakes, so they're open by design. If a family wants
more control here, the right escape hatch is a **single soft household toggle**, not a
per-role matrix (see below). We have not built one.

## Not committed — a possible future toggle

A "**kids' list additions need an OK**" household setting (a lightweight approval gate on
list adds) has been floated. We are **not** building it now — attribution covers the real
need, and a per-role lists matrix is more machinery than a family hub wants. It's recorded
as a maybe so the rationale isn't lost, not as a commitment.

---

See the [feature matrix](/reference/features/) for per-surface support and
[`ROADMAP.md`](https://github.com/OWNER/nook/blob/main/ROADMAP.md) (item 3.4) for the engineering history.
