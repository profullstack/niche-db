# Algorithms (`/c/algorithms`)

A reference shelf of algorithms, data structures and machine-learning
methods, assembled from the open catalogues that carry them whole. It exists
because "where do I find a real dataset of algorithms and methods for a
knowledge base" has no good answer on the open web: the sources are scattered,
two of the best are frozen archives, and one of those is three-quarters spam.
Every row here names its source and its licence, so a knowledge base built
from the collection can say where each entry came from.

## Sources

| Source | Slug | Rows | Kinds | Licence | Cadence |
| --- | --- | --- | --- | --- | --- |
| NIST Dictionary of Algorithms and Data Structures | `nist-dads` | about 1,120 pages, 1,290 names | algorithm, data-structure, technique, problem, definition | public domain (US government work) | a pass every month, 150 pages a run |
| Wikidata | `wikidata-algorithms` | about 2,700 algorithms and 470 data structures | algorithm, data-structure | CC0 | a pass every week, a handful of SPARQL requests |
| Papers With Code archive, methods | `pwc-methods` | 8,725 rows before the spam filter | method | CC BY-SA 4.0 | a pass every month; the archive is frozen |
| Papers With Code archive, datasets | `pwc-datasets` | 15,008 rows before the spam filter | dataset | CC BY-SA 4.0 | a pass every month; the archive is frozen |
| Rosetta Code | `rosetta-code` | 1,355 tasks and 424 drafts | task | GFDL 1.3 | a pass every week, 100 tasks a run |
| The Algorithms | `thealgorithms` | tens of thousands of implementations across 18 language repos | implementation | MIT | a pass every week, one repo a batch |

The `research` collection gained `openalex-algorithms` at the same time: the
newest OpenAlex works under Computer Science whose title or abstract says
"algorithm", every three hours, with the abstract rebuilt from OpenAlex's
inverted index. OpenAlex is CC0 and keyless.

## What each row carries

- **NIST DADS**: the definition, and the graph the dictionary is built on as
  `generalizations`, `specializations`, `partOf`, `uses`, `seeAlso` and `aka`,
  each a list of `{ name, file }` pointing at the other entry; the editorial
  note; the author's initials; links to implementations. The index letter
  (A, D, P, S, T) and the page's own type line give the kind. Undated.
- **Wikidata**: the English description, every class the item is filed
  under (as tags, so a feed can pick `sorting-algorithm` or `block-cipher`),
  the Wikipedia article as the row's URL, `inception` at the precision
  Wikidata states it, `discoverers`, and the four complexity labels
  (`worstTime`, `averageTime`, `bestTime`, `worstSpace`) when stated.
- **Papers With Code methods**: the description, the introducing paper, the
  year (2000 is read as unknown; the archive used it as a default), the
  source paper URL as the row's URL, the code snippet link, the number of
  papers using it, and the areas and collections it was filed under.
- **Papers With Code datasets**: the homepage as the row's URL, the
  introducing paper, modalities, tasks, languages, licence name, variants
  count, data loaders, and the introduction date.
- **Rosetta Code**: the task statement with the wiki markup stripped, the
  task group, categories, the Wikipedia article it points at, and every
  language it has a solution in with the count.
- **The Algorithms**: the implementation's name, language, category and
  subcategory, and the file on GitHub as the row's URL.

## The spam in the Papers With Code archive

Meta shut paperswithcode.com on 2025-07-24 and the last export sits on the
Hugging Face Hub under `pwc-archive`. In the site's final months its
submission form was abused, and on 2026-09-22 a sample page of the methods
archive was 74 spam rows in 100: airline and cruise "customer service"
posts with a phone number for a description, filed as methods with an
alphabetically-first paper attached. `isSpam` in
`packages/adapters/src/pwc-archive.js` drops a row whose name asks a
question, is longer than 100 characters, carries brackets or arrows, uses
the call-centre vocabulary, or has a US phone number in its name or
description. The vocabulary costs one real entry ("Support Vector Machine",
because of "support"); that is accepted and noted in the test.

## Reading it for a knowledge base

- The collection page is `/c/algorithms`; each source has a feed:
  `/f/algorithm-dictionary`, `/f/algorithms-on-wikidata`, `/f/ml-methods`,
  `/f/ml-datasets`, `/f/rosetta-tasks`, `/f/algorithm-implementations`, and
  `/f/algorithm-papers` in research.
- Every feed is also RSS, JSON Feed and an API endpoint under `/api/v1`, and
  the CLI (`nichedb`) and the MCP server expose the same reads. Reads need no
  key.
- The Data plan's hourly dumps ([data-dumps.md](data-dumps.md)) include the
  collection as NDJSON, which is the shortest path to a local vector index.

## Upstream facts worth keeping

- The Hub's rows API refuses `length` over 100, so a pass over the methods
  is 88 requests and over the datasets 151.
- Rosetta Code's Quicksort page has 169 level-2 sections but 168 distinct
  languages ("Hobbes" heads two); `languages` keeps each name once.
- `DIRECTORY.md` differs per repo: Python links categories, C++ and Java use
  absolute `/blob/HEAD/` links, Rust heads everything `## src`, TypeScript
  nests test files under a `Test` item. Go and Lua have no `DIRECTORY.md`.
- Wikidata timestamps are full even when only the year is known, so a
  January first is stored at year precision.
- OpenAlex's `sort=publication_date:desc` returns works dated in the future
  unless the filter carries `publication_date:<=today`.
