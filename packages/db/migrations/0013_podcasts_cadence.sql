-- The podcasts sources actually poll every fifteen minutes.
--
-- #34 set `cadenceMinutes: 15` on the adapter, which decides what a source is
-- created with and nothing else. `insertSource` is idempotent on the slug and
-- its conflict clause updates `name`, `description` and `updated_at` -- not
-- `config`, and not `cadence_minutes`. That is deliberate: cadence is on the
-- list of things an operator may edit from the sources page, so re-asserting
-- the adapter's number on every boot would silently undo a human's decision the
-- next time the web app restarted.
--
-- The cost of that is this file. The two podcast sources were created while the
-- adapter still said 60, so they kept 60, and the change in #34 reached exactly
-- nothing that was already running. Nothing failed and no run errored; the
-- catalogue walk simply proceeded at a quarter of the intended rate, which is
-- the kind of wrong that is only visible if you go and look.
--
-- So the two rows are moved by hand, once. Scoped by slug rather than by
-- adapter so a source somebody added themselves against the same adapter keeps
-- whatever cadence they chose for it, and conditional on the current value
-- still being 60 so that re-running this never overwrites a later decision.
--
-- A fresh deployment reaches the same place without this: seeding creates both
-- sources from the adapter, which now says 15.

update sources
   set cadence_minutes = 15,
       updated_at = now()
 where slug in ('podcasts-commercial', 'podcasts-self-hosted')
   and cadence_minutes = 60;
