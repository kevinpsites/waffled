-- Up Migration
-- 0101 belongs to the separately reviewed reward-correction chain (#143).
ALTER TABLE pantry_items ADD COLUMN storage_key text;

-- Older pantry clients saved media URLs. Recover owned keys from those URLs,
-- including expired signatures and absolute URLs; leave external CDN images alone.
UPDATE pantry_items
   SET storage_key = substring(image_url from '/([0-9a-f-]{36}/[0-9a-f]{32}\.(?:jpg|png|webp))(?:\?|$)'),
       image_url = null
 WHERE image_url ~ ('^(https?://[^/]+)?/([^/?]+/)*' || household_id::text || '/[0-9a-f]{32}\.(jpg|png|webp)(\?.*)?$');

ALTER TABLE pantry_items ADD CONSTRAINT pantry_media_key_household CHECK (
  storage_key IS NULL OR storage_key ~ ('^' || household_id::text || '/[0-9a-f]{32}\.(jpg|png|webp)$')
);

-- Down Migration
-- Restore the legacy durable URL representation for the old application.
UPDATE pantry_items SET image_url = '/media/' || storage_key WHERE storage_key IS NOT NULL;
ALTER TABLE pantry_items DROP COLUMN storage_key;
