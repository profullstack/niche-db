# Fetch routes: c0mpute and W3BS desktops

Every source fetches from the deployment's own address first. A few
publishers refuse that address no matter how politely it asks: an edge that
answers 403 to every path, a challenge page in front of a CSV, a rate limit
already spent. For those answers (403, 429, 451, and a 503 that is a
challenge page) the HTTP client every adapter uses (`packages/core/src/http.js`)
asks the same question again from another machine, through the routes in
`packages/core/src/fetch-routes.js`:

1. **c0mpute.** A `container.run` job on one of our own
   [c0mpute](https://c0mpute.com) nodes runs `curl` in a small image and
   returns the body and status as two outputs. The request leaves from that
   node's address. Only builders named in `FETCH_ROUTE_C0MPUTE_PEERS` are
   asked, never any worker, because the builder controls the bytes it returns.
2. **A W3BS desktop.** A person's own desktop, enrolled on
   [w3bs.org](https://w3bs.org/fleet), answers `POST /v1/fetch` over a
   tunnel. It is a residential address with a real browser behind it, which
   is what a challenge page is checking for, and the
   [Agentic Desktop Layer](https://w3bs.org/desktop) can drive that browser
   when a page needs more than a GET.

A route that is not configured is skipped. When every route is refused, the
adapter gets the direct answer it would have got anyway. Each rerouted
response carries `x-fetch-route` so a run log says which road it took.

## Configuration

| Variable | Meaning |
|---|---|
| `FETCH_ROUTE_C0MPUTE_URL` | the c0mpute jobs bridge (`c0mpute jobs serve`), e.g. `http://127.0.0.1:8788` |
| `FETCH_ROUTE_C0MPUTE_TOKEN` | the bridge's bearer token |
| `FETCH_ROUTE_C0MPUTE_PEERS` | comma-separated builder peer ids that may run the fetch |
| `FETCH_ROUTE_DESKTOP_URL` | where the desktop's tunnel lands on this box, e.g. `http://127.0.0.1:<port>` |
| `FETCH_ROUTE_DESKTOP_TOKEN` | the desktop's bearer token |

An adapter that must never leave the direct road passes `reroute: false` on
the request.

## Defining a desktop

A signed-in user defines a desktop environment once and the deployment can
use it from then on:

1. Sign in at w3bs.org and enroll the desktop: `w3bs fleet join <token>`. It
   appears under the account at w3bs.org/fleet.
2. The desktop opens the tunnel itself, outbound. Nothing on the desktop
   listens to the internet.
3. The deployment reaches back through that same tunnel to the desktop's
   fetch endpoint, and the desktop answers through it.

That is a two-way connection over one outbound link: the desktop dials the
server, and the server sends requests back down the line the desktop opened.

### The one in use: dev2 and bonita

nichedb.dev runs on **dev2**. **bonita** is a desktop with the W3BS desktop
layer installed. bonita keeps the tunnel to dev2 open (bonita → dev2), and
dev2 sends work back through it (dev2 → bonita). This is the first
desktop route, and the shape every user-defined desktop follows.

### The rule for the tunnel

Forward the fetch endpoint and nothing else. A tunnel that also carries a
shell hands the desktop to anyone who ever gets hold of the server's key, and
a desktop holds a person's browser profiles, wallets and keys. The fetch
endpoint takes a URL and returns a body behind its own bearer token: that is
all a server needs from a desktop to read the web.

## The desktop's side of the contract

```http
POST /v1/fetch
Authorization: Bearer <FETCH_ROUTE_DESKTOP_TOKEN>
Content-Type: application/json

{"url": "https://example.gov/data.csv", "headers": {"accept": "text/csv"}, "timeoutMs": 60000}
```

The answer is the upstream body as it came, with the upstream status in
`x-upstream-status` and its `content-type` passed through. Any other status
on the outer response means the desktop could not try (asleep, the person
declined, no browser), and the next route is asked.
