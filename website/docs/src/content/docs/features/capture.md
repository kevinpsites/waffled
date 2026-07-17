---
title: Add anything — the capture bar
description: A single natural-language input that parses a thought into the right event, task, grocery item, meal, or list item — or acts on an existing chore or goal.
---

The "Add anything" bar is the fast front door to the whole app — one natural-language box where you dump a thought and it lands in the right place. Type "dentist next Tuesday at 3", "milk and eggs", or "taco night Thursday" and the bar figures out whether that's an event, a task, a grocery item, a meal, or a list item. It can also act on what's already there — "mark set the table done for Elaine", "log 30 minutes on my reading goal" — with a quick confirm before anything changes. No navigating, no forms. ✨

## Highlights

- 🧭 **Routes a phrase** → event · task · grocery · meal · list · unsupported, resolving your household-local "now" and family names as it goes.
- ✅ **Acts on existing things too** — mark a chore done or hand it to someone else, log progress on a goal, straight from the bar; you confirm the exact match before anything commits. See [Acting on existing things](#acting-on-existing-things).
- 🔁 **Understands recurrence** — "lunch every Thursday for a month" parses into an **RRULE**, editable via **Repeats / Ends** right in the preview.
- 🔌 **Pluggable provider per household** — Anthropic · OpenAI-compatible · Ollama, with a configurable model; the active provider/model is stored per household. See [AI providers](/administration/ai-providers/).
- ⚡ **Instant, then better** — an on-device parse shows immediately, then upgrades to the LLM with a provider tag (**"improving…"**); on a kind-disagreement you can pick the other take, and it **backfills recurrence** when a weak model drops it.
- 🛟 **Creating always works** — a heuristic fallback keeps new captures functioning offline, with no provider, or when the provider defers. Acting on existing things talks to your server to find the real item, so it needs a connection.

## Acting on existing things

The bar isn't just for adding — it can change what's already there:

- "mark set the table done for Elaine"
- "give the dishes to Wally"
- "log 30 minutes on my reading goal"
- "add 10 hours to our outside goal"

The parser (your AI provider if configured, otherwise the on-device fallback) proposes **what you meant** — a verb plus a description of the target. Your server then deterministically finds the actual matching item(s) and shows a **pick-one candidate list** before anything commits. The AI only suggests; it never picks database rows.

- 🗓️ **Chore changes apply to today's instance**, not the recurring template — "mark the dishes done" completes today's dishes; next week's schedule is untouched.
- 🔒 **Permission-gated where it touches someone else** — handing a chore to another person needs `chore.manage`; logging on someone else's goal needs `goal.manage`. See [Permissions](/concepts/permissions/).
- 🚧 **Chores and goals for now** — events, list items, and rewards can't be changed from the bar yet (the bar says so when asked).

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

The capture bar behaves the same across every surface — the instant on-device parse, the LLM upgrade, and the editable recurrence preview all show up on Web/Kiosk, iPhone, and iPad. **Acting on existing things is Web/Kiosk-first** — iPhone and iPad still capture new things everywhere, with the act-on-existing flow coming to them next.

## Settings

**Settings → AI & capture** — pick your **provider** and **model**. Ollama has a warm-up step before its first parse (hosted providers are always warm). API keys live only in the server env; see the [AI providers](/administration/ai-providers/) admin page to set them.

## Module

The capture bar is **core — never gated**. It routes into whichever surfaces exist, so an intent only lands where that module is on — a **meal** intent, for example, only lands if [Meals & recipes](/features/meals/) is enabled.

## Notes

- 🛟 **Creates are offline-safe by design** — with no provider configured (or on a timeout) the route signals fallback and clients use the on-device heuristic, so *creating* always works, even offline. Changing an existing thing needs a connection to your server, because the server does the matching.
- 🧠 **The on-device fallback handles simple phrasings** ("mark the dishes done") — for reliable "do anything" parsing of the trickier ones, add an AI provider in **Settings → AI & capture**. Either way, the parse never leaves your infrastructure unless you point it at a hosted provider.
- 🚧 **Server-side fuzzy person resolution** (nicknames / aliases) is planned — for now, name matching resolves the family names it knows.
