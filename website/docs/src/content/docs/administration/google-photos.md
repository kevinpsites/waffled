---
title: Google Photos
description: Import photos from Google Photos into Waffled albums and mix them on the screensaver.
---

Waffled can bring photos in from **Google Photos** and turn them into albums for the photo
wall and the kiosk screensaver. Pick a few albums' worth, then set the screensaver to
**Several albums** and it plays a random mix of them.

## How it works

Google no longer lets apps read your Google Photos albums directly, so imports go through
**Google's own photo picker**:

1. In Waffled, open **Photos → 🌈 Google Photos** and choose (or name) the Waffled album to
   fill.
2. Google Photos opens in a new tab (or in the Google Photos app on iPhone/iPad). Select the
   photos you want. You can browse inside your Google albums and select everything in one, up
   to 2,000 photos per import.
3. Tap **Done** in Google Photos. Waffled downloads the photos into its own media storage and
   files them under that album.

Things to know:

- **Imports are copies, so re-sync to get new photos.** Google never pushes changes, so photos
  you add to a Google album later don't appear on their own. In **Settings → Display & Kiosk**,
  each imported album shows its photo count and last sync time, plus a **Re-sync** button.
  Re-sync, pick the album again in Google Photos, and only the photos Waffled doesn't already
  have are copied.
- **Photos only.** Videos in a pick are skipped.
- **Disconnecting removes them.** Disconnect deletes every photo imported from Google (and
  its file), the import history, and those albums from the screensaver mix. Photos you uploaded
  yourself stay. You're asked to confirm first.
- Only **admins** can connect Google Photos and run imports.

## One-time: enable the API on your Google OAuth client

Google Photos uses the same OAuth client as [Google Calendar](/administration/google-calendar/).
If you haven't created one yet, follow steps 1–3 there first.

1. In the [Google Cloud console](https://console.cloud.google.com/), open the same project and
   enable the **Photos Picker API**.
2. On the OAuth consent screen's **Data access** page, add the scope
   `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
3. On the OAuth client, add a second **authorized redirect URI**:
   `https://your.host/auth/google/photos/callback` (or
   `http://localhost:8080/auth/google/photos/callback` locally). Like the calendar callback,
   this path has **no `/api`** prefix.
4. Add it to `infra/compose/.env` next to the calendar settings, then `./waffled up`:

   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_PHOTOS_REDIRECT_URI=https://your.host/auth/google/photos/callback
   ```

   `TOKEN_ENCRYPTION_KEY` must be set as well, because the Google refresh token is stored
   encrypted with it.

The same redirect-URI limits apply as for the calendar: Google only accepts `https` on a
real domain, or `http://localhost`. A LAN IP address or a `.local` name is refused.

> **⚠️ Testing mode.** While the consent screen is in **Testing**, only the Google accounts
> listed as test users can connect, and Google expires the connection after 7 days. Imported
> photos stay, but you'd have to reconnect before the next import. Publishing the consent
> screen avoids both (see the calendar page's
> [notes on publishing](/administration/google-calendar/)).

## Connect and import

1. **Settings → Display & Kiosk → Google Photos → Connect Google Photos**, and approve the
   access request.
2. **Photos → 🌈 Google Photos**, then choose an album and click **Open Google Photos**.
3. Back in **Settings → Display & Kiosk**, set **Photo source** to **Several albums** and tick
   the albums to mix. With none ticked, it plays every photo.

On iPhone and iPad the same controls live under **Settings → Display & Kiosk** (source
**Mix**) and the Photos screen's **Google Photos** button.

## Troubleshooting

- **"The Google Photos Picker API is turned off in your Google Cloud project"** — enable the
  **Photos Picker API** on the project that owns your OAuth client (the dialog links straight to
  it). It can take a few minutes to take effect; then try the import again.
- **Settings says Google Photos is "not set up"** — the server is missing `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_PHOTOS_REDIRECT_URI` or `TOKEN_ENCRYPTION_KEY`. Restart the
  api after setting them.
