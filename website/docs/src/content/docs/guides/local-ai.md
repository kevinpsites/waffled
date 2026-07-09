---
title: Run AI locally with Ollama
description: Power the capture bar and meal AI with a model on your own hardware.
---

You'll end up with the **"Add anything"** capture bar and meal/recipe AI running
on a model on your own hardware — nothing leaving your network, no API keys to a
cloud provider.

## 1. Install Ollama

Install [Ollama](https://ollama.com) on the host machine, or on any other
machine on your network.

## 2. Pull a model

A **7–8B model is meaningfully better** than a 3B one for parsing and recipe AI —
small models get loose and mis-parse:

```bash
ollama pull llama3.1
```

## 3. Point Waffled at Ollama

In `infra/compose/.env`, set the host and model. The right host depends on where
Docker is running:

```bash
# Docker Desktop (macOS / Windows):
OLLAMA_HOST=http://host.docker.internal:11434

# Bare Linux (Docker bridge address):
OLLAMA_HOST=http://172.17.0.1:11434

OLLAMA_MODEL=llama3.1
```

Then apply it:

```bash
./waffled up
```

Full variable reference: [Environment variables](/install/environment-variables/)
and [AI providers](/administration/ai-providers/).

## 4. Select the provider in the app

Open **Settings → AI & capture** and choose **Ollama** plus your model. This is
per-household. What the capture bar actually does:
[AI capture bar](/features/capture/).

## Verify

Type something into the capture bar, e.g.:

```
dentist next Tuesday at 3pm
```

Confirm it parses into an **event** with the right date and time. The **first
request after idle may lag** while the model warms up in memory — hosted
providers are always warm, but a local model has to load. Subsequent requests
are quick.

## Notes

- **Keys and models never leave your server.** This is the fully local path.
- With **no provider set** (or on a timeout), the capture bar still works via an
  **on-device heuristic** — you never lose the "Add anything" box.
- **Prefer 7–8B or hosted Claude.** Small models (e.g. `llama3.2:3b`) mis-parse
  often enough to be frustrating. See
  [AI providers](/administration/ai-providers/) for the full config, including
  hosted options.
