---
title: Add a recipe from a photo or your voice
description: Turn a photo of a recipe card — or a rambly description — into a proper recipe with AI.
---

Typing a recipe in by hand is a chore. Waffled can build the whole thing for you from
a **photo** of a physical recipe, or from you just **describing it** out loud. Either
way you get a filled-in editor to review and tidy before saving — nothing is stored
until you hit save.

Both live on the **New recipe** screen: open **Meals → Recipes → ＋ New recipe**. Above
the form you'll see the import options.

## From a photo

Tap **📷 From a photo**, then snap or choose one or more photos of a recipe card,
cookbook page, or handwritten note. A recipe spread across a couple of pages is fine —
add all the photos and Waffled reads them as one recipe. Tap **Read → fill the form**
and the title, ingredients (with sections), and numbered steps drop into the editor.

- Up to **6 photos**, each under **10 MB**. JPEG, PNG, or WebP (iPhone HEIC photos are
  converted for you when you pick them in a browser that supports it).
- The photos are held only long enough to read them, then **automatically deleted**
  (about a day). They're never attached to the saved recipe — add a hero image
  separately if you want one.

## Describe it

Tap **🎤 Describe it** and either type or dictate what you know, in any order:

> Grandma's chili — brown a pound of ground beef with an onion, add two cans of kidney
> beans, a can of diced tomatoes, chili powder and cumin, simmer about 30 minutes.

Tap **Turn into a recipe** and it's organized into ingredients and steps. On browsers
that support speech input, the **🎤 Dictate** button lets you talk instead of type.

## Which AI provider you need

Recipe AI uses the same provider you pick in **Settings → AI & capture**:

- **Describe it** works with **any** provider (Claude, OpenAI-compatible, or a local
  Ollama model).
- **From a photo** needs a **vision-capable** model — **Claude**, **OpenAI**, or an
  Ollama vision model (for example `llava` or `llama3.2-vision`). If your current
  provider can't read images, the photo option is hidden and only **Describe it**
  shows.

If you haven't set up a provider yet, see the AI capture setup in Settings; the
on-device fallback can't do either import, so pick a real provider to use these.
