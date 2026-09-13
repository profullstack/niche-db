import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from '@profullstack/favicon-generator';

const root = fileURLToPath(new URL('../', import.meta.url));
const master = join(root, 'brand/logo.svg');
const publicDir = join(root, 'apps/web/public');
const source = await readFile(master, 'utf8');
const maskable = source
  .replace(
    'id="nichedb-background" width="512" height="512" rx="112"',
    'id="nichedb-background" width="512" height="512"',
  )
  .replace(/ {2}<rect id="nichedb-rim"[^>]*\/>\n/, '')
  .replace(
    '<g id="nichedb-mark">',
    '<g id="nichedb-mark" transform="translate(30.72 30.72) scale(0.88)">',
  );

await writeFile(join(root, 'brand/logo-maskable.svg'), maskable);
await copyFile(master, join(publicDir, 'logo.svg'));

// Keep the geometry identical for each existing member-selected app icon.
const colors = ['#202735', '#12161f', '#ffda96', '#f2a33a', '#f2c875', '#5ee39a', '#a6f5cf'];
const palettes = {
  mono: ['#111111', '#111111', '#e8e8e8', '#e8e8e8', '#e8e8e8', '#e8e8e8', '#e8e8e8'],
  mint: ['#152f27', '#0d1a16', '#b2f5da', '#5ee3b0', '#8beabe', '#f2a33a', '#ffda96'],
  ember: ['#352015', '#1c110c', '#ffbd8b', '#f2703a', '#f59e55', '#f2d03a', '#fff1a6'],
  ultraviolet: ['#2c203a', '#17111f', '#e0c8ff', '#b98cf5', '#c8b3eb', '#5ee39a', '#a6f5cf'],
};
for (const [name, palette] of Object.entries(palettes)) {
  const replacements = new Map(colors.map((color, index) => [color, palette[index]]));
  const svg = source.replace(/#[0-9a-f]{6}/g, (color) => replacements.get(color) ?? color);
  await writeFile(join(publicDir, `icons/app-${name}.svg`), svg);
}

// The library also emits example manifests and HTML. Stage its output so the
// application's own manifest and icon settings remain the source of truth.
const staging = await mkdtemp(join(tmpdir(), 'nichedb-brand-'));
try {
  await generateIcons({ inputPath: master, outputDir: staging, verbose: false });
  await generateIcons({
    inputPath: join(root, 'brand/logo-maskable.svg'),
    outputDir: staging,
    iconSizes: [192, 512].map((size) => ({ size, name: `icon-${size}x${size}-maskable.png` })),
    generateFavicon: false,
    generateRootFavicons: false,
    verbose: false,
  });
  for (const file of await readdir(staging)) {
    if (/\.(png|ico|svg)$/.test(file)) {
      await copyFile(join(staging, file), join(publicDir, 'icons', file));
    }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log('Updated the NicheDB logo, theme variants, favicons, and app icons.');
