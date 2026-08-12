-- Up Migration
-- Waffled-Bite alarm tones: store a stable key, not the English label.
--
-- `settings.alarm.tone` shipped holding the picker's DISPLAY STRING — the
-- database literally contained 'Sunrise chime'. That made the stored value and
-- the on-screen copy the same string, with two consequences: renaming a label
-- for copy reasons would silently repoint every already-paired device's alarm,
-- and the value could never be localised, because the stored value *is* the
-- English text. The web and iOS panels now store keys ('sunriseChime'); this
-- rewrites the rows written before they did.
--
-- Safe to land on its own schedule, in either order relative to a firmware
-- release: wb_tone_parse already accepts BOTH spellings (see wb_tone.h), so an
-- un-migrated row, a migrated row, and a row written by an app that hasn't been
-- updated yet all ring the same tone.
--
-- Only the six labels the picker has ever offered are rewritten. Anything else
-- is left exactly as found — a value we don't recognise is not ours to guess
-- at, and the firmware already has a defined fallback for one (it rings the
-- default tone rather than staying silent, because an alarm that makes no
-- noise has failed at its only job). Rows already holding a key match nothing
-- here, which is also what makes this idempotent: re-running it is a no-op.
update waffled_bite_devices d
set settings = jsonb_set(d.settings, '{alarm,tone}', to_jsonb(m.key))
from (values
  ('Sunrise chime', 'sunriseChime'),
  ('Birdsong',      'birdsong'),
  ('Soft harp',     'softHarp'),
  ('Gentle bells',  'gentleBells'),
  ('Ocean tide',    'oceanTide'),
  ('Twinkle stars', 'twinkleStars')
) as m(display, key)
-- Matching on ->>'tone' also gates the write: a device with no alarm block, or
-- an alarm block with no tone, yields NULL, matches no row here, and so is
-- never handed to jsonb_set (which would otherwise CREATE the key).
where d.settings->'alarm'->>'tone' = m.display;

-- Down Migration
-- The reverse map, so rolling back the apps rolls back the data with them: a
-- reverted web/iOS panel writes and compares display strings, and would show no
-- chip selected for a device left holding a key.
--
-- Lossless for every row this migration touched (the mapping is 1:1). The one
-- thing it cannot know is whether a row held a key *before* the up migration
-- ran — there were none when this shipped, but a device paired by an updated
-- app in the meantime would be rewritten to a display string here. That is the
-- correct outcome anyway: after a rollback, display strings are what the apps
-- read.
update waffled_bite_devices d
set settings = jsonb_set(d.settings, '{alarm,tone}', to_jsonb(m.display))
from (values
  ('Sunrise chime', 'sunriseChime'),
  ('Birdsong',      'birdsong'),
  ('Soft harp',     'softHarp'),
  ('Gentle bells',  'gentleBells'),
  ('Ocean tide',    'oceanTide'),
  ('Twinkle stars', 'twinkleStars')
) as m(display, key)
where d.settings->'alarm'->>'tone' = m.key;
