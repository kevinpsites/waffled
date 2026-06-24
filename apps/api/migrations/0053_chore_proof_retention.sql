-- Up Migration
-- Photo-proof retention: proof photos are throwaway verification, not memories, so
-- a background sweep deletes the blob N days after the chore is settled (default 3,
-- configurable per household at settings.chores.proofTtlDays). `had_proof` records
-- that a proof WAS attached so the UI can still say "approved with a photo (no
-- longer available)" once the blob is gone — it survives the sweep, unlike
-- proof_storage_key / proof_content_type which get nulled.

alter table chore_instances add column if not exists had_proof boolean not null default false;

-- Down Migration

alter table chore_instances drop column if exists had_proof;
