-- The agent question loop: where the AI admits it does not know something and
-- the human who does gets paid for the answer.
--
-- This is the part that makes a Knowledge Influencer's day a few minutes long
-- instead of an open-ended obligation to go and find something to contribute.
-- The agent is building for a niche, hits a question that only somebody who
-- has done the job can settle, and asks. The answer becomes niche knowledge
-- and a scored contribution in the same transaction.

create table agent_questions (
  id          bigserial primary key,
  -- Chovy's own id for the question. Idempotency lives on this: a webhook
  -- delivered twice must not put the same question in front of a person twice.
  external_id text,
  niche_id    bigint not null references niches(id) on delete cascade,
  -- Which agent asked. A logical name (`chovy-niche-commercial-roofing`),
  -- matching niches.primary_agent_id; there is no agents table to join.
  agent_id    text,
  title       text not null,
  question    text not null,
  -- UNTRUSTED. This is whatever the agent gathered while getting stuck: pages
  -- it crawled, snippets it found, its own reasoning. It is rendered as text
  -- and it is never instructions. Nothing reads this column and does what it
  -- says, on either side of the loop.
  context     text,
  -- [{ id, label }]. When present the operator picks rather than types, which
  -- is what makes a two-minute answer possible.
  options     jsonb not null default '[]',
  urgency     text not null default 'normal',
  constraint agent_questions_urgency check (urgency in ('low', 'normal', 'high')),
  related_resource_ids jsonb not null default '[]',
  -- open: waiting on a human. answered: somebody settled it. dismissed: an
  -- operator or admin said it is not worth answering.
  -- researching: a human asked the agent to go back and find out more.
  status      text not null default 'open',
  constraint agent_questions_status
    check (status in ('open', 'researching', 'answered', 'dismissed')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create index agent_questions_queue_idx
  on agent_questions (niche_id, status, created_at desc);
-- The dashboard's only hot query: what is still waiting, worst first.
create index agent_questions_open_idx
  on agent_questions (niche_id, urgency, created_at) where status in ('open', 'researching');
-- A redelivery books once. Partial, because a question raised by hand has no
-- external id and two of those must not collide.
create unique index agent_questions_external
  on agent_questions (niche_id, external_id) where external_id is not null;

-- What a human said back.
--
-- Kept as its own table rather than columns on the question because "I do not
-- have enough context" is a real answer that has to be recorded without
-- closing the question, and because a niche with several operators can have
-- more than one of them weigh in.
create table agent_answers (
  id            bigserial primary key,
  question_id   bigint not null references agent_questions(id) on delete cascade,
  influencer_id uuid not null references users(id) on delete cascade,
  -- answered:            a real answer, which scores.
  -- insufficient_context: the question cannot be answered as asked.
  -- needs_research:      go and find out more, then ask again.
  --
  -- The last two score nothing and cost nothing. An operator who feels pressed
  -- to answer because answering is what pays will guess, and a guess that gets
  -- verified becomes wrong knowledge that the data quality never recovers
  -- from. Declining has to be free.
  kind          text not null default 'answered',
  constraint agent_answers_kind
    check (kind in ('answered', 'insufficient_context', 'needs_research')),
  -- The option chosen, when the question offered any.
  option_id     text,
  body          text,
  -- The scored contribution this answer created, when it created one. Null for
  -- a decline, which is the whole point of the column being nullable.
  contribution_event_id bigint references contribution_events(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- One answer per person per question. Changing your mind is a new question,
  -- not a second payment for the same one.
  unique (question_id, influencer_id)
);
create index agent_answers_question_idx on agent_answers (question_id);
create index agent_answers_influencer_idx on agent_answers (influencer_id, created_at desc);
