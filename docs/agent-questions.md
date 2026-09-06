# The agent question loop

**Where the AI admits it does not know something, and the person who does gets paid for the answer.**

An agent is building or researching for a niche and hits something only
somebody who has done the job can settle. Two sources disagree about roofing
waste percentages. Steam lists an early-access date and a 1.0 date and only one
of them is the release. It cannot read its way out of that, so it asks.

```
YOUR AGENT NEEDS YOUR EXPERTISE

Do early-access dates count as releases?
Steam lists an early access date and a 1.0 date.

  ( ) Early access date
  ( ) 1.0 date

[Answer]  [Not enough context]  [Ask the agent to research more]
```

The answer becomes niche knowledge and a scored contribution in the same
request. That is the flywheel: the agent's ignorance is what generates the
human's income, so a niche with an active agent gives its operator a steady,
bounded reason to show up.

## The round trip

```
Chovy agent
    |  POST /api/v1/internal/expert-questions   (signed)
    v
agent_questions ──> the operator's dashboard
                          |
                          |  answers, declines, or sends it back
                          v
                    agent_answers
                          |
             +------------+------------+
             |                         |
             v                         v
     contribution_events        expert_answer.created
     (agent_answer, 3pts)       delivered back to Chovy
             |
             v
       score -> tier -> revenue share
```

## What a person can say

Three answers, and two of them are not answers. That is deliberate.

| | What happens | Points |
| --- | --- | ---: |
| **Answer** | Question closes, Chovy is told, a contribution is recorded | 3 |
| **Not enough context** | Recorded, question stays open for someone else | 0 |
| **Ask the agent to research more** | Question goes to `researching`, Chovy is told | 0 |

Declining has to be free, and it is worth being explicit about why. If the only
paid action is answering, an operator who half-knows will guess. A guess that
gets verified becomes wrong knowledge in a dataset other people pay to read,
and nothing downstream can tell it apart from the real thing. A question left
open costs a day. A confident wrong answer costs the niche its credibility.

## Signing

The internal route creates work that pays, so it is signed rather than merely
internal. An unsigned endpoint here is a way to mint scored contributions.

```
X-Chovy-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
signed payload:    `${t}.${rawBody}`
secret:            CHOVY_SIGNING_SECRET
tolerance:         300 seconds
```

The same scheme this deployment already verifies for CoinPay webhooks, and the
same in both directions, so Chovy verifies our answers with the code it uses to
sign its questions. `packages/knowledge/src/signing.js` is the shared
implementation; it takes strings, not request objects, so both sides can use it.

Unset the secret and the route answers 503. That is deliberate: no default, no
fallback, and no quiet acceptance of unsigned work.

The HMAC is over the raw request text, never a re-serialised object.
`JSON.stringify(JSON.parse(x))` is not always `x`.

## Untrusted context

A question carries `context`: whatever the agent scraped on the way to being
stuck. It is the highest-risk field in this system, because it is attacker-
influenced text travelling to a human and then back into a model's context.

Three rules, all enforced in code rather than by intention:

1. It renders as escaped text inside a `<blockquote>` labelled "What the agent
   found", so a reader can see it is reported material and not the site
   talking. A `<script>` tag in it is displayed, not run.
2. Nothing on either side interpolates it into instructions. The migration says
   so at the column and the answer path never concatenates it.
3. It is length-capped on the way in, so a question cannot be a denial of
   service against the page that shows it.

## Idempotency

A question carries the agent's own `externalId`. A redelivered webhook returns
`{"duplicate": true}` and the original question, so nothing appears twice in
front of a person.

An answer is guarded twice over. The `unique (question_id, influencer_id)`
constraint settles a race, and only the request that wins it goes on to score.
Under that, the contribution's own dedupe key is derived from the question id,
so even a double-scored path books once.

## Trying it

```sh
export CHOVY_SIGNING_SECRET=dev-secret
BODY='{"payload":{"nicheSlug":"games","externalId":"q-1","title":"Which date?",
       "question":"Early access or 1.0?","urgency":"high",
       "options":[{"id":"ea","label":"Early access"},{"id":"full","label":"1.0"}]}}'
T=$(date +%s)
MAC=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$CHOVY_SIGNING_SECRET" -hex | sed 's/.*= *//')

curl -X POST localhost:3000/api/v1/internal/expert-questions \
  -H 'content-type: application/json' \
  -H "x-chovy-signature: t=$T,v1=$MAC" -d "$BODY"
```

It then appears on `/dashboard/niches` for every active operator of that niche.

## Endpoints

```
POST /api/v1/internal/expert-questions          signed; an agent asking
GET  /api/v1/niches/:slug/questions             members and admins only
POST /api/v1/niches/:slug/questions/:id/answer  members only

GET  /dashboard/niches/:slug/questions          the queue, as a page
POST /dashboard/questions/:id/answer            what the form posts
POST /dashboard/questions/:id/dismiss           not worth anybody's time
```

Questions are not public. They carry the agent's raw research, and a niche's
open problems are not something to publish while they are open.

## Tests

```sh
bun test test/signing.test.js   # tamper, replay, wrong secret, clock skew
bun test test/schema.test.js    # redelivery, one answer per person, declines score nothing
```
