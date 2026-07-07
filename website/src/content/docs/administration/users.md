---
title: Users & members
description: Add family members, grant logins, invites, and roles.
---

A household is a set of **people**. Some people have a login and sign in; some are
just profiles (kids on a kiosk). This page covers adding members, giving them a way
to sign in, inviting people to join, and the break-glass tools when you're locked
out. For *who can do what*, see [Permissions & roles](/concepts/permissions/) — this
page won't re-explain the capability grid.

## Add a person

Add people in **Settings → Family & People**. Each person has:

| Field | Notes |
|---|---|
| Name | Display name across the app |
| Avatar | Photo or initials |
| Color | Their accent color (chips, calendar, attribution) |
| `member_type` | **adult / teen / kid** — carries authorization (see below) |
| Birthday | Optional; feeds calendar countdowns |

A person can exist as a **profile without a login** — this is the normal setup for
kids. They don't sign in with an email; instead they act as themselves on a paired
tablet via the profile picker (and an optional PIN). See
[Kiosk & devices](/administration/kiosk/).

## Grant a login

On a person's card you can grant a login: an **email** plus an **optional password**.

- **With a password** — they sign in with the standard sign-in form.
- **Email only** — they sign in via **SSO** once OIDC is configured, and only if
  they've been invite-gated for it. See [Authentication & SSO](/administration/authentication/).

The **owner login is protected** — it's the first account created by the setup
wizard and can't be removed the way an ordinary login can. Removing anyone's login
**revokes that person's active sessions** immediately.

## Roles & authorization

Two things drive what a member can do:

- **`member_type`** (adult / teen / kid) carries authorization. Capabilities default
  **adult = on, teen/kid = off**.
- **`is_admin`** — the household **owner** — is always a superuser.

The owner tunes a **per-capability grid per household** in Settings. What each
capability gates, the defaults, and the "you can always act on your own stuff"
carve-outs all live in [Permissions & roles](/concepts/permissions/).

## "Saving toward" a reward

The reward a person is **saving toward** is set per person, on their card. This is
part of the rewards presentation, not a role setting.

## Invites

To bring in a new member who'll have their own login:

1. An **admin** creates an **invite** for the person.
2. The invited person **accepts** the invite to join the household.

This is also how email-only / SSO members get access — the invite gates who is
allowed to sign in via OIDC.

## Multiple households

An account can belong to **more than one household** and switch which one is active.
An admin can **create an additional household** and invite people into it. Each
household has its own people, modules, and permission grid.

## Break-glass from the host

If no one can sign in as an admin, you don't need a login — run these on the host:

```bash
./waffled admin reset-password     # reset a member's password
./waffled admin make-admin         # grant admin to a member
./waffled admin list-members       # see who exists
./waffled admin prune-sessions     # invalidate active sessions
```

Full walkthrough in [Troubleshooting → Locked out](/operations/troubleshooting/).

## See also

- [Permissions & roles](/concepts/permissions/) — the capability grid
- [Authentication & SSO](/administration/authentication/) — OIDC and invite-gated login
- [Kiosk & devices](/administration/kiosk/) — profiles, the picker, and PINs
- [Modules](/administration/modules/) — turn features on per household
