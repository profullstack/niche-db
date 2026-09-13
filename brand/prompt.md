# NicheDB logo design prompt

Design and maintain a distinctive SVG identity for NicheDB, the open database
whose promise is **Sources in. Feeds out.** People and software agents access
the same growing collection through the web, RSS, JSON, API, CLI, and MCP.

Use this file as a standalone design prompt. It may become the project-specific
brief for a Markdown design skill when the W3BS design standard is published.

## Design reference

- Intended reference: <https://w3bs.org/standards/design>.
- Status: **coming soon; conformance pending**. The reference could not be
  retrieved when this brief was created. The guidance below is NicheDB's local
  brief, not a published W3BS specification or certification.
- When the reference becomes available, read its actual requirements, compare
  them with this brief and the SVG, and record any required changes. Do not
  invent requirements or claim compliance with an unpublished standard.

## Visual direction

Create a confident, precise identity for a database used by autonomous agents.
Express connection and data flow through the geometry of the mark itself.

- Use the supplied sculpted mark: three amber data layers surrounding a
  mint-green agent core on an obsidian tile. The open upper layer cradles the core.
- Preserve the graphite, amber, and mint identity, generous negative space,
  named gradients, and semantic groups. Keep the layer silhouette legible at 16px.
- Keep the identity specific to NicheDB. Avoid stock sparkle symbols, robot
  faces, decorative circuit diagrams, and tiny lettering inside the icon.
- Use a quiet rounded graphite tile for the primary logo. Use a full-bleed
  background for maskable icons so the operating system can apply its own crop.
- Render the site-header logo at **56 × 56 CSS pixels** on desktop and mobile,
  100% larger in each dimension than the previous 28 × 28 mark. Keep its full
  square viewBox visible and prevent flex layouts from shrinking it, so the
  sculpted layers and core remain visible. Navigation may wrap around the brand.

| Role | Color |
| --- | --- |
| Graphite | `#11181F` |
| Surface highlight | `#202932` |
| Data amber | `#F29932` |
| Amber highlight | `#FFE3A0` |
| Agent mint | `#5EE39A` |
| Core highlight | `#D4FFE0` |

## SVG requirements

- Edit `brand/logo.svg` as the master. Use a `0 0 512 512` viewBox and explicit
  dimensions. Keep it comfortably below 5 KB before compression.
- Use editable SVG geometry and local gradients. Keep every resource inside
  the file: no embedded bitmap, external font, external asset, script, event
  handler, or `foreignObject`.
- Include a meaningful `title` and `desc`, connected to `role="img"` through
  `aria-labelledby`. When embedding the logo with an adjacent NicheDB wordmark,
  use an empty HTML image `alt` to avoid repeating the accessible name.
- Preserve the supplied semantic SVG IDs. If multiple copies are inlined in one page,
  give each copy unique IDs and update its references; `<img>` embeds are isolated.
- Keep the default mark static. Recognition must not depend on animation,
  fine highlights, color differences, or hover effects.
- Keep the essential maskable mark inside the centered circle with radius
  40% of the canvas width. The current generator scales the mark to 88% and
  uses a full-bleed tile without the inset border.

## Deliver and verify

1. Edit `brand/logo.svg` (the supplied `~/logo.svg` is the initial master) and
   run `bun run build:brand`. SVGCrusher writes the optimized root `favicon.svg`;
   `fav -i favicon.svg` renders the PNG/ICO, Apple, and PWA fallbacks. The script
   copies the crushed SVG to `apps/web/public/logo.svg`, `favicon.svg`, and
   `icons/favicon.svg`, and refreshes all member icon palettes and maskable PNGs.
   If changing the semantic `surface` group, update the maskable derivation too.
2. Open `brand/preview.html` for the large mark, light and dark backgrounds,
   real-size favicons, theme variants, and a circular mask preview.
3. Inspect at 16, 32, 48, 56, 192, and 512 pixels. The stacked layers and mint
   core should remain recognizable; fine highlights may simplify at small sizes.
4. Check XML validity, local reference integrity, image dimensions, transparent
   primary corners, and opaque maskable corners. The public SVG copies must
   match `favicon.svg`; keep the editable master uncompressed.
5. Run the repository's required checks. SVG is the preferred favicon and is
   offered in the PWA manifest; PNG/ICO and Apple touch icons remain available.
