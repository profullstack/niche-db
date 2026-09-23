#!/usr/bin/env python3
"""Split a `pg_dump --section=post-data` script into two files.

  pk.sql    PRIMARY KEY constraints. Applied before the initial copy: logical
            replication finds the row for every UPDATE/DELETE by its replica
            identity, and without a key that is a sequential scan of items.
  rest.sql  Everything else (indexes, unique/foreign keys, triggers). Applied
            after the copy, which is several times faster than maintaining
            26 GB of indexes row by row while 72 GB streams in.

The session preamble (SET ..., set_config, \\restrict) is copied into both.

usage: split_post_data.py post.sql pk.sql rest.sql
"""
import re
import sys


def statements(text):
    """Yield top-level SQL statements. pg_dump post-data has no function bodies,
    so a semicolon at the end of a line closes a statement."""
    buf = []
    for line in text.splitlines(keepends=True):
        if not buf and (line.startswith('--') or not line.strip()):
            continue
        buf.append(line)
        if line.rstrip().endswith(';') or line.startswith('\\'):
            yield ''.join(buf)
            buf = []
    if ''.join(buf).strip():
        yield ''.join(buf)


def main(src, pk_out, rest_out):
    text = open(src, encoding='utf-8').read()
    preamble, pk, rest = [], [], []
    for stmt in statements(text):
        head = stmt.lstrip()
        if head.startswith('\\') or re.match(r'SET |SELECT pg_catalog\.set_config', head):
            preamble.append(stmt)
        elif re.search(r'\bPRIMARY KEY\b', stmt):
            pk.append(stmt)
        else:
            rest.append(stmt)
    # \unrestrict closes \restrict: keep it at the end of both files.
    tail = [s for s in preamble if s.lstrip().startswith('\\unrestrict')]
    head = [s for s in preamble if not s.lstrip().startswith('\\unrestrict')]
    for path, body in ((pk_out, pk), (rest_out, rest)):
        with open(path, 'w', encoding='utf-8') as f:
            f.write(''.join(head) + '\n' + '\n'.join(body) + '\n' + ''.join(tail))
    print(f'{len(pk)} primary keys, {len(rest)} other post-data statements')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
