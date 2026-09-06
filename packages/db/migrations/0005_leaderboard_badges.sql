-- Badges for the public leaderboard (@profullstack/leaderboard).
--
-- Everything else the board shows is projected live out of crawl_sales and
-- referral_usages, so it has no tables of its own. Badges are the exception:
-- they are awarded at a moment and then kept, so "top ten this week" still
-- reads as earned after the week ends. That fact lives nowhere else.
create table if not exists leaderboard_badges (
  player     text        not null,
  badge      text        not null,
  awarded_at timestamptz not null default now(),
  primary key (player, badge)
);
