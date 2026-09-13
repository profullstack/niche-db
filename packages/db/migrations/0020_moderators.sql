-- Moderators: people who keep a niche's queue clean without operating it.
--
-- A moderator is a niche member with a role of its own: they review what is
-- suggested for the niche's collection and earn nothing, so their share cap
-- is zero and no score row is opened for them. Applying to moderate is a
-- claim like any other, marked with the role asked for, and only an admin
-- decides it. More than one moderator per niche is the point.

alter table niche_members drop constraint niche_members_role;
alter table niche_members
  add constraint niche_members_role
  check (role in ('operator', 'specialist', 'observer', 'moderator'));

alter table niche_claims add column role text not null default 'operator';
alter table niche_claims
  add constraint niche_claims_role check (role in ('operator', 'moderator'));
