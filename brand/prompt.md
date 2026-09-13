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

- Build a bold **N** from two vertical rails and one diagonal connection.
  Two open circular ports make the route feel connected and programmable.
- Preserve the existing graphite, amber, and mint identity. Amber represents
  incoming sources; mint represents outgoing feeds. The N and its open ports
  must remain recognizable in one color.
- Use generous negative space, rounded endpoints, and restrained shading.
  The diagonal connection sits in front of the rails, with a dark separation
  stroke and a fine highlight that adds depth at large sizes.
- Keep the identity specific to NicheDB. Avoid stock sparkle symbols, robot
  faces, decorative circuit diagrams, and tiny lettering inside the icon.
- Use a quiet rounded graphite tile for the primary logo. Use a full-bleed
  background for maskable icons so the operating system can apply its own crop.

| Role | Color |
| --- | --- |
| Graphite | `#12161f` |
| Surface highlight | `#202735` |
| Source amber | `#f2a33a` |
| Amber highlight | `#ffda96` |
| Bridge midpoint | `#f2c875` |
| Feed mint | `#5ee39a` |
| Mint highlight | `#a6f5cf` |

## SVG requirements

- Edit `brand/logo.svg` as the master. Use a `0 0 512 512` viewBox and explicit
  dimensions. Keep it comfortably below 5 KB before compression.
- Use editable SVG geometry and local gradients. Keep every resource inside
  the file: no embedded bitmap, external font, external asset, script, event
  handler, or `foreignObject`.
- Include a meaningful `title` and `desc`, connected to `role="img"` through
  `aria-labelledby`. When embedding the logo with an adjacent NicheDB wordmark,
  use an empty HTML image `alt` to avoid repeating the accessible name.
- Prefix SVG IDs with `nichedb-`. If multiple copies are inlined in one page,
  give each copy unique IDs and update its references; `<img>` embeds are isolated.
- Keep the default mark static. Recognition must not depend on animation,
  fine highlights, color differences, or hover effects.
- Keep the essential maskable mark inside the centered circle with radius
  40% of the canvas width. The current generator scales the mark to 88% and
  removes the rounded background and inset border.

## Deliver and verify

1. Edit the master SVG and run `bun run build:brand`. This regenerates the
   public logo, monochrome/mint/ember/ultraviolet variants, PNG and ICO favicons,
   Apple touch icons, and maskable app icons using the existing icon generator.
   If changing SVG IDs or palette colors, update `scripts/generate-brand.js` too.
2. Open `brand/preview.html` for the large mark, light and dark backgrounds,
   real-size favicons, theme variants, and a circular mask preview.
3. Inspect at 16, 28, 32, 48, 192, and 512 pixels. The N must survive at favicon
   size; the two ports and edge highlight may simplify when downsampled.
4. Check XML validity, local reference integrity, image dimensions, transparent
   primary corners, and opaque maskable corners. Confirm generated copies match
   the master and retain existing asset paths and theme names.
5. Run the repository's required checks. Report the delivered files, validation,
   and the pending W3BS reference status accurately.
