-- Up Migration
-- Blob-storage backing for photos and recipes. Until now a photo/recipe image was
-- ONLY an external image_url (or, for photos, an emoji tile). With the upload
-- endpoint (POST /api/media) an image can now live in our own blob store; we record
-- its opaque storage_key (and content_type) here. The public URL is resolved at READ
-- time from the key (mediaUrl(), base = MEDIA_BASE_URL) so the base can change
-- without a migration. Both columns are nullable and additive — external links keep
-- working unchanged; a row with a storage_key resolves its image from the blob store
-- first, falling back to image_url.

alter table photos  add column storage_key text;
alter table photos  add column content_type text;

alter table recipes add column storage_key text;
alter table recipes add column content_type text;

-- Down Migration

alter table photos  drop column if exists storage_key;
alter table photos  drop column if exists content_type;

alter table recipes drop column if exists storage_key;
alter table recipes drop column if exists content_type;
