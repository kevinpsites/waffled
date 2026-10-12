# Google Photos import

**Status:** shipped (web, kiosk, iPhone, iPad).

## Why the Picker API

Since 2025-03-31 the Google Photos Library API only returns media the app itself created. An
app can't list or read a user's existing albums any more. The supported route is the
**Photos Picker API** (`photospicker.mediaitems.readonly`):

- The user picks items in Google's UI, up to 2,000 per session, and can browse inside their
  albums while picking.
- Picked `baseUrl`s expire after about 60 minutes, and session access ends with the session.

So Waffled **copies** each pick into the BlobStore. A Google album can't stay "linked".

## Shape

- Each import = one picker session = one Waffled album (`photos.memory`).
- `photos.source = 'google_photos'` and `external_id` hold the Google media id. A unique index
  on `(household_id, source, external_id)` makes re-picking idempotent.
- `google_photos_imports` tracks `picking → importing → done | failed | expired`.
  - Polling `GET /api/photos/google/imports/:id` asks Google whether the user has finished.
  - The first poll that sees `mediaItemsSet` moves the import to `importing` (a guarded UPDATE)
    and starts the download in a background job.
- Downloads ask for `=w2560-h2560` so Google serves JPEG/PNG/WebP, never HEIC. Videos are skipped.
- Disconnect hard-deletes the imported photo rows and their files, the import history, and any
  mix album left with no photos. Hard delete (not soft) so a reconnect can import the same items.
- Settings lists each imported album (photo count, last sync) with a **Re-sync** button that
  reopens the picker pre-filled with that album.
- The screensaver's `albums` source (`photoAlbums`, max 50) mixes several albums. It always
  shuffles, because a random mix is the point.

## Not done

- **Auto-refresh of new Google photos.** The Picker API can't do it. A re-pick is the workflow.
- **iCloud shared albums.**
