---
title: AI providers
description: Configure the AI behind the capture bar and meal/recipe features — Anthropic, OpenAI-compatible, or a local Ollama.
---

Waffled's AI features — the ["Add anything" capture bar](/features/capture/), meal/recipe
planning, and calendar heads-ups — run through **one pluggable provider interface**. You can use
a hosted model, a local one, or none at all. **Keys live only on the server**, and the app always
degrades gracefully to an on-device heuristic when no provider is set or you're offline.

## The three provider options

| Provider | Set in `.env` | Notes |
|---|---|---|
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`) | Hosted; the most reliable for parsing and recipe AI. |
| **OpenAI-compatible** | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | Works with OpenAI **and** any compatible endpoint (LM Studio, llama.cpp, vLLM) via `OPENAI_BASE_URL`. |
| **Ollama (local)** | `OLLAMA_HOST` (+ `OLLAMA_MODEL`) | A model running on your own hardware; nothing leaves the network. |
| **None** | — | Capture still works via a deterministic on-device heuristic. |

You can set **more than one** — the active provider and model are chosen **per household** in
**Settings → AI & capture**.

## Set it up

1. Add the key(s) for whichever provider you want in `infra/compose/.env`, then `./waffled up`.
   Examples:

   ```bash
   # Anthropic
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_MODEL=claude-haiku-4-5-20251001

   # OpenAI or compatible
   OPENAI_API_KEY=sk-...
   OPENAI_MODEL=gpt-4o-mini
   OPENAI_BASE_URL=https://api.openai.com/v1   # or your local endpoint

   # Local Ollama
   OLLAMA_HOST=http://host.docker.internal:11434
   OLLAMA_MODEL=llama3.1
   ```

2. In the app, open **Settings → AI & capture** and pick the **provider** and **model** for your
   household.

That's it — the capture bar, meal/recipe AI, and calendar heads-ups now use it.

## Running a local model with Ollama

Point `OLLAMA_HOST` at an Ollama instance on your network:

- **Docker Desktop (Mac/Windows):** `OLLAMA_HOST=http://host.docker.internal:11434`.
- **Bare Linux:** use the Docker bridge address, e.g. `OLLAMA_HOST=http://172.17.0.1:11434`.

Ollama models are **cold** until first use — Waffled warms the model on demand (hosted providers
are always warm), so the first parse after a while may take a beat.

> **Model size matters.** Small local models (e.g. `llama3.2:3b`) are loose and frequently
> mis-parse. A **7–8B** model, or hosted Claude, is meaningfully more reliable for both capture
> parsing and recipe AI. If local AI feels flaky, this is usually why.

## Privacy & fallback

- **Keys never leave the server** — clients call your api, which calls the provider. The app
  doesn't ship keys to the device.
- **Always works offline.** With no provider configured, or on a timeout (`AI_TIMEOUT_MS`,
  default 30 s), the capture route signals `fallback` and clients parse with the built-in
  heuristic. You never get a dead input box.
- **Outbound only when you opt in.** Hosted providers are the only path that sends text off your
  machine — and only for the AI features, only when you've set a key.

## What AI powers

- **Capture bar** — natural language → event / task / grocery / meal / list, with recurrence.
- **Meals** — "Plan my week/month", "Try something new", and recipe metadata auto-fill.
- **Calendar** — the "heads up this week" digest and per-event insight.

🚧 **Conversational recipe AI** ("make it gluten-free", photo → recipe) and **fuzzy person
resolution** (nicknames) are planned, not yet shipped.
