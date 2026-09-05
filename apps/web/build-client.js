/**
 * Bundles the browser helpers into public/ as globals, so the pages keep
 * working under a strict CSP with no third-party origin in the path of
 * signing in.
 */
const BUNDLES = [['webauthn-entry.js', 'vendor-webauthn.js']];

for (const [entry, name] of BUNDLES) {
  const out = await Bun.build({
    entrypoints: [new URL(`./src/client/${entry}`, import.meta.url).pathname],
    outdir: new URL('./public', import.meta.url).pathname,
    naming: name,
    minify: true,
    target: 'browser',
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    process.exit(1);
  }
  console.log(`[build] ${name}`);
}
