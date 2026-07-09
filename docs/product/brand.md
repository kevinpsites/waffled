# Waffled — brand & voice

The source of truth for how Waffled sounds and positions itself, across the
marketing site (`website/home`), the docs (`website/docs`), in-app copy, and the
iOS App Store. If you're writing a headline, a button, a changelog line, or a
feature blurb, start here.

> This was distilled from the product's existing tagline, license, and design
> system — not handed down from on high. If a rule feels wrong, change it here
> first, then update the copy that depends on it.

## What Waffled is (in one line)

**The self-hosted family hub — one household, one source of truth.**

Calendar, chores, meals, lists, pantry, goals, and photos for a whole household,
on a kitchen kiosk, everyone's phone, and a server you control.

## Positioning — free to self-host, paid to have us host it

This is the part most likely to be phrased inconsistently, so pin it down:

- **Self-hosting is the product, and it's free — forever.** Waffled is AGPL open
  source. The whole app, every feature, runs on your own hardware at no cost.
  We never hold features back behind a paid tier. This is *not* open-core.
- **Managed hosting is a convenience we sell.** Some people want Waffled but
  don't want to run a server. For them we (will) offer a managed instance —
  updated, backed up, online — for a fee. Same app, we just operate the box.
- **Why we charge for it:** the goal isn't profit; it's that running servers for
  other people costs money and time, so hosted plans fund the open-source work.
  Frame it as *"it funds the project,"* the Ghost / Terraform Cloud model — never
  as "premium" or "pro."

**Say it like:** "Host it yourself for free, or let us host it for you." ·
"Same app either way — the only question is who runs the server." · "Paid, and
it funds the open-source project."

**Don't say:** "free tier" / "premium" / "pro" / "upgrade" (implies locked
features — there are none) · "enterprise" · anything that makes self-hosting
sound like the lesser option.

> Status: managed hosting is **planned, not live**. Until it ships, present it as
> *"Coming soon"* with a low-commitment CTA (register interest / waitlist) — never
> imply you can sign up today.

## Voice — four rules

1. **Plain over clever.** Short declarative sentences. State what it does, not how
   amazing it is. No hype words (revolutionary, seamless, effortless, magical,
   game-changing). If a sentence would survive being said out loud to a friend,
   keep it.
   - ✅ "Clone the repo, run one command, done."
   - ❌ "Experience the effortless magic of family organization."

2. **Warm, but technical.** The reader is a capable person setting up software for
   people they love. Respect both halves: friendly and domestic, but never
   dumbed-down or cutesy. `./waffled up` and "pin a tablet to the fridge" belong
   in the same paragraph.
   - ✅ "A native SwiftUI app with offline sync and Apple Health goals."
   - ❌ "Your magical family command center in the cloud!"

3. **Privacy is the emotional hook.** The reason to care is ownership: your
   family's life stays on hardware you control, not sold, not mined, not
   ad-supported. Lead with it in value moments.
   - ✅ "Your family's life isn't a product."
   - ❌ "Enterprise-grade security and compliance."

4. **Concrete nouns over abstractions.** Household, kiosk, fridge, chore, star,
   pantry, countdown, dinner — not "solutions," "experiences," "platforms,"
   "ecosystems." Name the real thing on the screen.

## Vocabulary

- **Use:** household, family, kitchen kiosk, the fridge, self-host, your server,
  your data, open source, modules, the Today dashboard, stars (the reward
  currency), chores.
- **Avoid:** users (say "your household" / "family"), solution, platform,
  ecosystem, leverage, seamless, unlock, empower, robust, cutting-edge.
- **The AI:** "the capture bar" and "bring your own model / key." Never imply we
  send data to our servers — the user picks the provider (local Ollama or their
  own key).

## Naming & capitalization

- The product is **Waffled** (capital W, always). Never "the Waffled app" when
  "Waffled" alone reads fine.
- Domains: **waffled.app** (marketing home), **docs.waffled.app** (docs), and a
  future **api.waffled.app**. Lowercase in prose.
- The CLI/command is `./waffled` (lowercase, monospace).
- License: **AGPL-3.0**. Say "open source," not "free software."

## Look & feel (pointers, not the source)

The visual tokens live in code and must stay in sync — don't restate values here:

- App: `apps/web/src/styles/waffled.css`
- Docs: `website/docs/src/styles/docs.css`
- Home: `website/home/src/styles/home.css`

The through-line: **warm cream canvas, ink text, a coral primary action, gold
stars, violet for AI.** Display type is a calm old-style serif (the app uses
Apple's "New York"; the web uses **Newsreader** as its cross-platform cousin —
avoid swashy/wonky serifs like Fraunces, whose descending "f" reads as broken).
Body type is a clean humanist sans (**Instrument Sans** on the web, SF in the app).
