# Hosting verification, September 13, 2026

Verified the deployed [Hosting collection](https://nichedb.dev/c/hosting) and
public APIs at about 16:27 UTC. The original directory and import work is
delivered: [PR 64](https://github.com/profullstack/niche-db/pull/64) and
[PR 65](https://github.com/profullstack/niche-db/pull/65) are merged. The checked
source revision was `b68afe6`.

## Published data

The collection page and [source API](https://nichedb.dev/api/v1/sources?collection=hosting)
agree on 1,400 items. All nine enabled sources have a successful run and a daily
refresh scheduled for September 14.

| Source | Items |
| --- | ---: |
| FindHost providers | 185 |
| Vultr plans | 174 |
| Linode types | 75 |
| Scaleway instances | 135 |
| OVH VPS, US | 175 |
| OVH VPS, EU | 70 |
| LowEndBox | 20 |
| Storefronts | 552 |
| BuyVPS | 14 |

Reading the public storefront API through its three pages returned 552 distinct
external IDs from 13 WHMCS hosts: 507 plans and 45 addons. The latest recorded
storefront run finished at 03:14 UTC, updating 112 existing rows and adding eight.
All 185 provider records carry `FindHost, findhost.app, CC BY 4.0` attribution.
Sample Vultr and DigitalOcean provider records contain Wikipedia, OpenGraph, and
developer-tool enrichment; DigitalOcean also has the company-ticker enrichment.

## Reading and feed checks

The collection, item API, source API, and each of the six feed APIs and RSS URLs
returned HTTP 200. Counts below use a 200-item API request; the plans result is
bounded by that limit.

| Feed | API items | Check |
| --- | ---: | --- |
| [Providers](https://nichedb.dev/f/hosting-providers) | 185 | Provider rows only; attribution retained |
| [Plans](https://nichedb.dev/f/vps-plans) | 200 | Plan rows only |
| [Under 5](https://nichedb.dev/f/vps-under-5) | 27 | Every price is monthly and below 5 in its stated currency |
| [Bare metal](https://nichedb.dev/f/bare-metal-plans) | 23 | Every offer has kind `bare-metal` |
| [Deals](https://nichedb.dev/f/hosting-deals) | 7 | Deal rows only |
| [Providers with a CLI](https://nichedb.dev/f/hosting-cli) | 47 | Provider rows only |

RSS responses parsed as XML. They contain a promotional item in addition to the
data items; their default data limit is 100.

## Classification correction

The live [Google Workspace seat](https://nichedb.dev/i/10035891) and
[online-storage product](https://nichedb.dev/i/10035895) both had the fallback
`vps` offer kind. Their stored public raw records reproduce the problem without
network access. Recognize Google Workspace/G Suite as addons and the French
`stockage` group as storage.

Replaying all 552 public storefront records through the corrected mapper changes
exactly eight classifications: four Workspace products become addons, and four
storage products become storage plans. All 552 external IDs stay identical, so
the ordinary source upsert can correct the rows without creating duplicates.
The fixture regression failed before the change and passed after it. The focused
hosting, storefront, keyed-source, enrichment, and BuyVPS checks pass (77 tests).
The full suite passes: 1,575 tests across 91 files. Repository-wide Biome passes
with existing warnings.

## Limits and deployment status

Verification used public GET requests and local fixture tests. It did not trigger
an import, production write, credential lookup, or paid request. No ServerHunter
source was added. Hetzner, DigitalOcean, UpCloud, and OpenServer remain disabled
with zero rows; their optional credentials or descriptors were not supplied.

The classification correction is not deployed. The eight live records therefore
still need the reviewed change deployed and an ordinary storefront refresh.
The next daily refresh is scheduled; a second daily run has not yet occurred.
