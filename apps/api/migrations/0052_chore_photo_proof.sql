-- Up Migration
-- Optional photo-proof gate on a chore, mirroring requires_approval. When set,
-- completing an instance requires attaching a proof photo (a blob in waffled_media);
-- a parent then sees the photo in the approvals queue. Like requires_approval the
-- flag is snapshotted onto the instance at materialization, so editing the chore
-- later doesn't retroactively change in-flight instances. The proof itself
-- (storage_key + content_type, same shape as photos/recipes) lives on the instance.

alter table chores add column if not exists requires_photo boolean not null default false;
alter table chore_instances add column if not exists requires_photo boolean not null default false;
alter table chore_instances add column if not exists proof_storage_key text;
alter table chore_instances add column if not exists proof_content_type text;

-- Down Migration

alter table chore_instances drop column if exists proof_content_type;
alter table chore_instances drop column if exists proof_storage_key;
alter table chore_instances drop column if exists requires_photo;
alter table chores drop column if exists requires_photo;
