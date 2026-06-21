-- Member management: an admin can give a family member a login. A login is a
-- credentials row (email always; password optional). password_hash becomes
-- nullable so an admin can invite a member to SSO by email alone — the OIDC flow
-- matches credentials.email (invite-gating) without a password being set.
alter table credentials alter column password_hash drop not null;
