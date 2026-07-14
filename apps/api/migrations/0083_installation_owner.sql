-- Up Migration
-- Installation-wide authentication settings need a durable owner that is
-- independent of household ordering and nullable household owner rows.

alter table auth_config
  add column installation_owner_account_id uuid references accounts(id);

update auth_config
   set installation_owner_account_id = (
     select p.account_id
       from households h
       join persons p on p.id = h.owner_person_id
       join accounts a on a.id = p.account_id and a.deleted_at is null
      where p.account_id is not null
      order by h.created_at, h.id
      limit 1
   )
 where id = true and installation_owner_account_id is null;

-- Down Migration

alter table auth_config drop column if exists installation_owner_account_id;
