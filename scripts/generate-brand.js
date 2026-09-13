import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from '@profullstack/favicon-generator';
import { crushSvg } from '@profullstack/svgcrusher';

const root = fileURLToPath(new URL('../', import.meta.url));
const master = join(root, 'brand/logo.svg');
const favicon = join(root, 'favicon.svg');
const publicDir = join(root, 'apps/web/public');
const source = await readFile(master, 'utf8');
const crusherCli = fileURLToPath(
  new URL('../bin/svgcrusher.js', import.meta.resolve('@profullstack/svgcrusher')),
);
const favCli = fileURLToPath(
  new URL('../bin/cli.js', import.meta.resolve('@profullstack/favicon-generator')),
);

// Keep the editable source; ship and rasterize only the crushed SVG.
execFileSync(process.execPath, [crusherCli, master, '-o', favicon], { stdio: 'inherit' });
await mkdir(join(publicDir, 'icons'), { recursive: true });
await copyFile(favicon, join(publicDir, 'logo.svg'));
await copyFile(favicon, join(publicDir, 'favicon.svg'));

// Full-bleed tile, with the data layers and core inside the maskable safe circle.
const surface = /<g id="surface">[\s\S]*?<\/g>/;
if (!surface.test(source)) throw new Error('The master must contain the named surface group.');
const maskable = source
  .replace(
    surface,
    '<rect width="512" height="512" fill="url(#tile)"/>\n' +
      '<g id="maskable-mark" transform="translate(30.72 30.72) scale(0.88)">',
  )
  .replace('</svg>', '</g>\n</svg>');
const maskablePath = join(root, 'brand/logo-maskable.svg');
await writeFile(maskablePath, maskable);

// Retain shading and geometry while shifting the palette for member icons.
// Match paints only, so design metadata and accessible labels stay meaningful.
const hues = { mint: 155, ember: 22, ultraviolet: 270, mono: 0 };
function tint(hex, name) {
  const rgb = hex.match(/[0-9a-f]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  const hue = hues[name] / 60;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * (name === 'mono' ? 0 : saturation);
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const sectors = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  return `#${sectors[Math.floor(hue)]
    .map((channel) =>
      Math.round((channel + lightness - chroma / 2) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
for (const name of Object.keys(hues)) {
  const variant = source.replace(
    /((?:fill|stroke|stop-color)=")#([0-9a-f]{6})"/gi,
    (_, attr, hex) => `${attr}${tint(hex, name)}"`,
  );
  await writeFile(join(publicDir, `icons/app-${name}.svg`), crushSvg(variant).data);
}

// fav also emits example HTML/manifests. Stage its output before copying assets
// so the application's dynamic manifest remains authoritative.
const staging = await mkdtemp(join(tmpdir(), 'nichedb-brand-'));
try {
  execFileSync(process.execPath, [favCli, '-i', favicon, '-o', staging, '--silent'], {
    cwd: root,
    stdio: 'inherit',
  });
  await generateIcons({
    inputPath: maskablePath,
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
console.log('Updated the crushed SVG logo, theme variants, favicons, and app icons.');
