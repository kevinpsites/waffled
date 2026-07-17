---
title: Sending email with Gmail (SMTP)
description: Configure an SMTP server so Waffled can email your household a weekly summary.
---

Waffled can send email — starting with a **weekly digest** of your household's calendar,
meals, grocery list, and chores. You bring your own SMTP server; nothing is sent through
Waffled's infrastructure. The easiest option for most people is a **Gmail account with an
App Password**, exactly the setup Immich uses.

Everything is configured per household from **Settings → Notifications → Email**, and the
SMTP password is stored **encrypted** — so make sure `TOKEN_ENCRYPTION_KEY` is set (the
same key that protects your Google Calendar tokens). If it isn't, the password field is
disabled with a reminder.

## 1. Create a Gmail App Password

An App Password is a 16-character password that lets one app sign in to your Google
account without your real password.

1. In your **Google Account → Security**, turn on **2-Step Verification** (required — App
   Passwords don't exist without it).
2. Go to **App passwords**, create one (name it "Waffled"), and copy the 16-character
   value Google shows you. You won't be able to see it again.

## 2. Enter the settings in Waffled

In **Settings → Notifications → Email** (admins only):

| Field | Value |
| --- | --- |
| **Enabled** | on |
| **Host** | `smtp.gmail.com` |
| **Port** | `587` (STARTTLS) — or `465` with **SSL/TLS** turned on |
| **Username** | your full Gmail address |
| **Password** | the 16-character App Password |
| **From name / address** | how the email should appear (e.g. `Waffled <you@gmail.com>`) |

Leave **Ignore certificate errors** off unless you're using a self-signed relay.

## 3. Send a test email

Click **Send test email**. Waffled sends a message to your own account email using the
settings you entered, and **saves them on success**. If it fails, the exact SMTP error is
shown — usually a wrong App Password (`535 Authentication failed`) or the wrong port/SSL
combination.

## 4. Turn on the weekly digest

Toggle **Send weekly digest**, then pick the **day** and **hour** (in your household's
timezone) and which **sections** to include (calendar, meals, grocery, chores). The digest
goes to every adult member's account email, once per week.

## Notes & limits

- Consumer Gmail allows roughly **500 recipients/day** (2000 for Google Workspace) — far
  more than a household digest needs, but worth knowing if you reuse the account elsewhere.
- The weekly digest is sent by the **container** deployment's background scheduler. It is
  idempotent per week, so a container restart won't double-send.
- Any SMTP server works — this guide uses Gmail because it's the most common. Fastmail,
  a self-hosted relay, or a transactional provider all work the same way.
