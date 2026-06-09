-- Up Migration
-- A user-owned notes field, separate from the markdown `notes`. The importer
-- never writes this, so in-app edits (substitutions like "use chicken instead of
-- turkey", tweaks, reminders) survive every re-import of the source markdown.

alter table recipes add column user_notes text;

-- Down Migration

alter table recipes drop column if exists user_notes;
