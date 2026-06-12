-- Up Migration
-- User overrides for an imported recipe — a single jsonb blob the importer never
-- writes, merged over the markdown source at read time so in-app edits win and
-- survive every re-import. Keyed so it stays valid when ingredients/steps are
-- re-created on import (ingredient subs by lowercased name, step notes by number):
--   {
--     "meta":      { "protein": "chicken", "cuisine": "...", ... },  // scalar overrides
--     "dietary":   ["gluten-free"],                                  // replaces source
--     "addedTags": ["family-favorite"],                             // appended to source
--     "subs":      { "ground turkey": "ground chicken" },           // ingredient substitutions
--     "stepNotes": { "3": "we broil a bit longer" }                 // per-step notes
--   }

alter table recipes add column overrides jsonb not null default '{}';

-- Down Migration

alter table recipes drop column if exists overrides;
