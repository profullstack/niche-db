#!/usr/bin/env node
import { run } from '../src/index.js';

run(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  },
);
