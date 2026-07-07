---
title: Add anything — the capture bar
description: A single natural-language input that parses a thought into the right event, task, grocery item, meal, or list item.
---

The "Add anything" bar is the fast front door to the whole app — one natural-language box where you dump a thought and it lands in the right place. Type "dentist next Tuesday at 3", "milk and eggs", or "taco night Thursday" and the bar figures out whether that's an event, a task, a grocery item, a meal, or a list item. No navigating, no forms. ✨

## Highlights

- 🧭 **Routes a phrase** → event · task · grocery · meal · list · unsupported, resolving your household-local "now" and family names as it goes.
- 🔁 **Understands recurrence** — "lunch every Thursday for a month" parses into an **RRULE**, editable via **Repeats / Ends** right in the preview.
- 🔌 **Pluggable provider per household** — Anthropic · OpenAI-compatible · Ollama, with a configurable model; the active provider/model is stored per household. See [AI providers](/administration/ai-providers/).
- ⚡ **Instant, then better** — an on-device parse shows immediately, then upgrades to the LLM with a provider tag (**"improving…"**); on a kind-disagreement you can pick the other take, and it **backfills recurrence** when a weak model drops it.
- 🛟 **Always works** — a heuristic fallback keeps the bar functioning offline, with no provider, or when the provider defers.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

The capture bar behaves the same across every surface — the instant on-device parse, the LLM upgrade, and the editable recurrence preview all show up on Web/Kiosk, iPhone, and iPad.

## Settings

**Settings → AI & capture** — pick your **provider** and **model**. Ollama has a warm-up step before its first parse (hosted providers are always warm). API keys live only in the server env; see the [AI providers](/administration/ai-providers/) admin page to set them.

## Module

The capture bar is **core — never gated**. It routes into whichever surfaces exist, so an intent only lands where that module is on — a **meal** intent, for example, only lands if [Meals & recipes](/features/meals/) is enabled.

## Notes

- 🛟 **Offline-safe by design** — with no provider configured (or on a timeout) the route signals fallback and clients use the on-device heuristic, so the bar always works, even offline.
- 🚧 **Server-side fuzzy person resolution** (nicknames / aliases) is planned — for now, name matching resolves the family names it knows.
