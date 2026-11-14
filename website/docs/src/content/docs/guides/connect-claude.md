---
title: Connect Claude to Waffled
description: Add Waffled as a connector in Claude so it can read and update your household — signed in with your normal Waffled login.
---

You'll end up with Claude able to answer "what's for dinner Thursday?" or "which chores
are still open?", and to do things like "add milk to the grocery list" or "move soccer to
5pm" — acting as you, signed in with your ordinary Waffled login.

## Before you start: Claude has to be able to reach your server

**Connectors in claude.ai, Claude Desktop and the Claude mobile app call your server from
Anthropic's cloud, not from your computer.** So Waffled has to be on the public internet:

- reachable over **HTTPS** at a public hostname (for example `https://waffled.example.com`),
- with an **IPv4 address** (an `A` record) — private, CGNAT and loopback addresses are
  refused,
- and the URL must not redirect to another host.

Most installs are LAN-only, at an address like `http://192.168.1.20:8080`. That works for
everything else in Waffled, but not for these connectors. To give Waffled a public
hostname, put it behind a tunnel or a domain with Caddy's automatic TLS — see
[Reverse proxy & TLS](/install/reverse-proxy/).

**LAN-only?** You can still use [Claude Code](#claude-code-with-an-api-key) on a computer
on the same network, with an API key.

## 1. Find your MCP URL

Your server's MCP endpoint is your Waffled address plus `/mcp`:

```
https://<your-host>/mcp
```

Use exactly the address you open Waffled at, with no trailing slash.

## 2. Add Waffled as a custom connector

In Claude, open **Settings → Connectors**, choose **Add custom connector**, give it a name
(Waffled), and paste the MCP URL. Claude finds the sign-in page on its own; there is no
client ID or secret to enter.

## 3. Sign in and approve

Claude opens a Waffled page in your browser:

1. **Sign in** the way you normally do — password or your SSO button. If you are already
   signed in, this step is skipped.
2. **Approve the connection.** The page shows the app's name and **the site it will send
   you back to** (for Claude, `claude.ai`) — check it before you approve. If you belong to
   more than one household, pick the one Claude should use.
3. **Choose what it may do.** Reading is switched on and changing things is switched off
   until you turn it on — for example, leave **Add, move and cancel calendar events** off
   if you only want Claude to read your calendar.

Approve, and the browser returns to Claude, which can now use Waffled.

## What Claude can do

Claude can read today's overview, the calendar, chores, the grocery list and your other
lists, the meal plan, goals, reward balances, the family and the recipe library. With the
matching switches on, it can add an event, a list item, a chore or a planned meal; complete
or reassign a chore; check off or remove a list item; move or cancel an event; log goal
progress; and redeem a reward. The full list is in the
[feature matrix](/reference/features/#modules--extensibility).

It can never do more than you can: a tool is hidden when its module is off for the
household, and every change is held to your own [permissions](/concepts/permissions/). Each
change Claude makes is recorded against the connection that made it.

## Disconnect

Open **Settings → Connected apps** in Waffled, find the connection and choose **Revoke**.
Claude loses access on its very next request. To use it again, connect it again.

(The iPhone and iPad app does not show Connected apps yet; use the web app.)

## Kids and teens

Whether someone may connect an AI app is the **Connect AI apps** permission
(`ai.connect`). It is on for adults and off for teens and kids by default; an admin can
change it per role in **Settings → Family & People → Permissions**. Turning it off for a
role cuts off that role's existing connections on their next request too — not just new
ones.

## Claude Code with an API key

[Claude Code](https://claude.com/claude-code) can also connect with an API key instead of
signing in. This is the way to go when Waffled is only on your LAN, since Claude Code runs
on your own computer.

1. In Waffled, open **Settings → API Keys** (an admin tab) and create a key with the scopes
   Claude should have.
2. Add the server to Claude Code:

   ```bash
   claude mcp add --transport http waffled https://<your-host>/mcp \
     --header "Authorization: Bearer waffled_..."
   ```

A key acts as the person who made it, limited to its scopes, exactly like a connection.
Revoke it in **Settings → API Keys**.
