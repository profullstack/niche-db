import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  BRANCHES,
  CADENCE_MINUTES,
  DEFAULT_REPOS,
  directoryUrl,
  fetchDirectory,
  implementationItem,
  isTestPath,
  keep,
  languageOf,
  parseDirectory,
  pathOf,
  RUN_MINUTES,
  reposOf,
  resumeFrom,
  theAlgorithms,
  USER_AGENT,
} from '../packages/adapters/src/thealgorithms.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const python = await readFile(
  new URL('../packages/adapters/test/fixtures/thealgorithms-python-directory.md', import.meta.url),
  'utf8',
);

const CPP = `
## Backtracking
  * [Generate Parentheses](https://github.com/TheAlgorithms/C-Plus-Plus/blob/HEAD/backtracking/generate_parentheses.cpp)
  * [N Queens](https://github.com/TheAlgorithms/C-Plus-Plus/blob/HEAD/backtracking/n_queens.cpp)

## Tests
  * [Something](https://github.com/TheAlgorithms/C-Plus-Plus/blob/HEAD/tests/something.cpp)
`;

const RUST = `# List of all files

## src
  * Backtracking
    * [N-Queens](https://github.com/TheAlgorithms/Rust/blob/master/src/backtracking/n_queens.rs)
  * Sorting
    * Comparison
      * [Quick Sort](https://github.com/TheAlgorithms/Rust/blob/master/src/sorting/comparison/quick_sort.rs)
`;

const TS = `
## Backtracking
  * [All Combinations Of Size K](https://github.com/TheAlgorithms/TypeScript/blob/HEAD/backtracking/all_combinations_of_size_k.ts)
  * Test
    * [All Combinations Of Size K.Test](https://github.com/TheAlgorithms/TypeScript/blob/HEAD/backtracking/test/all_combinations_of_size_k.test.ts)
`;

describe('thealgorithms parsing', () => {
  test('the Python directory: linked headings, nested subdirectories, Docs and Project Euler', () => {
    const all = parseDirectory(python);
    const kept = all.filter(keep);
    const byPath = Object.fromEntries(kept.map((e) => [e.path, e]));
    expect(byPath['backtracking/minimax.py']).toEqual({
      name: 'Minimax',
      path: 'backtracking/minimax.py',
      category: 'Backtracking',
      subcategory: null,
    });
    expect(byPath['data_structures/binary_tree/avl_tree.py']).toMatchObject({
      category: 'Data Structures',
      subcategory: 'Binary Tree',
    });
    expect(byPath['data_structures/arrays/kth_largest_element.py'].subcategory).toBe('Arrays');
    // Present in the file, left out on purpose.
    expect(all.some((e) => e.path === 'docs/conf.py')).toBe(true);
    expect(kept.some((e) => e.path === 'docs/conf.py')).toBe(false);
    expect(all.some((e) => e.category === 'Project Euler')).toBe(true);
    expect(kept.some((e) => e.category === 'Project Euler')).toBe(false);
    // The table of contents (numbered list of anchors) is not an entry.
    expect(all.some((e) => e.path.startsWith('#'))).toBe(false);
    expect(kept.length).toBeGreaterThan(60);
  });

  test('absolute links, plain headings and a Tests section (C++)', () => {
    const kept = parseDirectory(CPP).filter(keep);
    expect(kept).toEqual([
      {
        name: 'Generate Parentheses',
        path: 'backtracking/generate_parentheses.cpp',
        category: 'Backtracking',
        subcategory: null,
      },
      {
        name: 'N Queens',
        path: 'backtracking/n_queens.cpp',
        category: 'Backtracking',
        subcategory: null,
      },
    ]);
  });

  test('a src heading is not a category: the first unlinked level is (Rust)', () => {
    const kept = parseDirectory(RUST).filter(keep);
    expect(kept).toEqual([
      {
        name: 'N-Queens',
        path: 'src/backtracking/n_queens.rs',
        category: 'Backtracking',
        subcategory: null,
      },
      {
        name: 'Quick Sort',
        path: 'src/sorting/comparison/quick_sort.rs',
        category: 'Sorting',
        subcategory: 'Comparison',
      },
    ]);
  });

  test('test files under a Test subdirectory are skipped (TypeScript)', () => {
    const kept = parseDirectory(TS).filter(keep);
    expect(kept.map((e) => e.path)).toEqual(['backtracking/all_combinations_of_size_k.ts']);
    expect(isTestPath('a/test/b.ts')).toBe(true);
    expect(isTestPath('a/b.test.ts')).toBe(true);
    expect(isTestPath('a/tests/b.py')).toBe(true);
    expect(isTestPath('a/testing/b.py')).toBe(false);
  });

  test('pathOf reads relative and absolute links and refuses directories and anchors', () => {
    expect(pathOf('backtracking/minimax.py')).toBe('backtracking/minimax.py');
    expect(pathOf('https://github.com/TheAlgorithms/C-Plus-Plus/blob/HEAD/a/b.cpp')).toBe(
      'a/b.cpp',
    );
    expect(pathOf('https://github.com/TheAlgorithms/Rust/blob/master/src/x.rs')).toBe('src/x.rs');
    expect(pathOf('#backtracking')).toBeNull();
    expect(pathOf('backtracking')).toBeNull();
    expect(pathOf('backtracking/')).toBeNull();
    expect(pathOf('https://github.com/TheAlgorithms/Rust/tree/master/src')).toBeNull();
  });

  test('languages, urls, repos', () => {
    expect(languageOf('C-Plus-Plus')).toBe('C++');
    expect(languageOf('Python')).toBe('Python');
    expect(directoryUrl('Zig', 'main')).toBe(
      'https://raw.githubusercontent.com/TheAlgorithms/Zig/main/DIRECTORY.md',
    );
    expect(BRANCHES).toEqual(['master', 'main']);
    expect(reposOf({})).toEqual(DEFAULT_REPOS);
    expect(reposOf({ repos: 'Python, C-Plus-Plus, Python, ../evil' })).toEqual([
      'Python',
      'C-Plus-Plus',
    ]);
    expect(reposOf({ repos: ['Go'] })).toEqual(['Go']);
  });

  test('an implementation item passes normalisation', () => {
    const item = implementationItem(
      {
        name: 'Avl Tree',
        path: 'data_structures/binary_tree/avl_tree.py',
        category: 'Data Structures',
        subcategory: 'Binary Tree',
      },
      'C-Plus-Plus',
      'master',
    );
    expect(item).toMatchObject({
      externalId: 'C-Plus-Plus:data_structures/binary_tree/avl_tree.py',
      kind: 'implementation',
      title: 'Avl Tree (C++)',
      url: 'https://github.com/TheAlgorithms/C-Plus-Plus/blob/master/data_structures/binary_tree/avl_tree.py',
      tags: ['thealgorithms', 'c', 'data-structures'],
      data: { language: 'C++', subcategory: 'Binary Tree', license: 'MIT' },
    });
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('resumeFrom keeps the branches learnt and starts over after a pass', () => {
    expect(resumeFrom(null)).toEqual({ index: 0, branches: {}, passStartedAt: null });
    expect(resumeFrom({ index: 3, branches: { Zig: 'main' }, passStartedAt: 't' })).toEqual({
      index: 3,
      branches: { Zig: 'main' },
      passStartedAt: 't',
    });
    expect(resumeFrom({ index: 0, branches: { Zig: 'main' }, done: true })).toEqual({
      index: 0,
      branches: { Zig: 'main' },
      passStartedAt: null,
    });
  });
});

/** A fake raw host: `files` maps `repo/branch` to markdown; anything else 404s. */
function raw(files, fail = () => false) {
  const urls = [];
  const http = {
    async request(url, opts) {
      urls.push(url);
      expect(opts.headers['user-agent']).toBe(USER_AGENT);
      if (fail(url)) return new Response('nope', { status: 500 });
      const m = url.match(/TheAlgorithms\/([^/]+)\/([^/]+)\/DIRECTORY\.md$/);
      const body = files[`${m[1]}/${m[2]}`];
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, { status: 200 });
    },
  };
  return { http, urls };
}

async function run(http, cursor, repos, deadline = Date.now() + 60_000) {
  const batches = [];
  const gen = theAlgorithms.pull({ config: { repos }, cursor, http, log: () => {}, deadline });
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { batches, outcome: value };
    batches.push(value);
  }
}

describe('thealgorithms pull', () => {
  test('one batch per repository, master then main, a missing repo skipped, then a week', async () => {
    const { http, urls } = raw({
      'Python/master': python,
      'TypeScript/main': TS,
      'Rust/master': RUST,
    });
    const { batches, outcome } = await run(http, null, ['Python', 'Go', 'TypeScript', 'Rust']);
    expect(batches.length).toBe(3);
    expect(batches[0].items.length).toBeGreaterThan(60);
    expect(batches[0].items[0].tags).toContain('python');
    expect(batches[0].cursor).toMatchObject({ index: 1, branches: { Python: 'master' } });
    expect(batches[1].items.map((i) => i.url)).toEqual([
      'https://github.com/TheAlgorithms/TypeScript/blob/main/backtracking/all_combinations_of_size_k.ts',
    ]);
    expect(batches[1].cursor).toMatchObject({ index: 3, branches: { TypeScript: 'main' } });
    expect(batches[2].items.map((i) => i.title)).toEqual(['N-Queens (Rust)', 'Quick Sort (Rust)']);
    expect(batches.flatMap((b) => b.items).every((i) => normaliseItem(i) !== null)).toBe(true);
    expect(outcome.nextInMinutes).toBe(CADENCE_MINUTES);
    expect(outcome.cursor).toMatchObject({ index: 0, done: true, branches: { Rust: 'master' } });
    expect(outcome.note).toContain('1 repositories without a DIRECTORY.md');
    // Go was probed on both branches; TypeScript on master first, then main.
    expect(urls.filter((u) => u.includes('/Go/')).length).toBe(2);
    expect(urls.filter((u) => u.includes('/TypeScript/'))).toEqual([
      'https://raw.githubusercontent.com/TheAlgorithms/TypeScript/master/DIRECTORY.md',
      'https://raw.githubusercontent.com/TheAlgorithms/TypeScript/main/DIRECTORY.md',
    ]);
  });

  test('the remembered branch is asked first on the next pass', async () => {
    const { http, urls } = raw({ 'TypeScript/main': TS });
    await run(http, { index: 0, branches: { TypeScript: 'main' }, done: true }, ['TypeScript']);
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/TheAlgorithms/TypeScript/main/DIRECTORY.md',
    ]);
  });

  test('fetchDirectory returns null on a double 404 and throws on anything else', async () => {
    const { http } = raw({});
    expect(await fetchDirectory(http, 'Go', null)).toBeNull();
    const bad = raw({ 'Python/master': python }, () => true);
    await expect(fetchDirectory(bad.http, 'Python', null)).rejects.toThrow(/answered 500/);
  });

  test('repeated failures keep the place; total failure throws', async () => {
    const { http } = raw({ 'Python/master': python, 'Rust/master': RUST }, (u) =>
      u.includes('/Rust/'),
    );
    const { batches, outcome } = await run(http, null, ['Python', 'Rust']);
    expect(batches.length).toBe(1);
    expect(outcome.nextInMinutes).toBe(RUN_MINUTES);
    expect(outcome.cursor).toMatchObject({ index: 1, done: false });
    expect(outcome.note).toContain('repeated failures');

    const dead = raw({}, () => true);
    await expect(run(dead.http, null, ['Python'])).rejects.toThrow(/every request failed/);
  });

  test('a past deadline ends the run before the next repository', async () => {
    const { http } = raw({ 'Python/master': python });
    const { batches, outcome } = await run(http, null, ['Python'], 0);
    expect(batches.length).toBe(0);
    expect(outcome.nextInMinutes).toBe(RUN_MINUTES);
    expect(outcome.cursor).toMatchObject({ index: 0, done: false });
  });
});
