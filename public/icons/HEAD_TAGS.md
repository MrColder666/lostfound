# Head tags — L&F icon & PWA wiring

Copy the block for each page into its `<head>`, after `<meta name="viewport">` and before the
stylesheet links. Paths are absolute from the site root (the Worker serves `public/` as `/`).
Do not change the icon files: the 16 px PNG and the `.ico` are optically tuned, and the
maskable/monochrome variants are only referenced from `manifest.webmanifest`.

---

## `public/index.html`

Replace the existing line that links the manifest and `icon-192` (right now line 6:
`<link rel="manifest" ...><link rel="icon" href="/icons/icon-192.png">`) with this block. The
`theme-color` meta on line 3 is already correct — leave it as is.

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/icon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/icons/icon-48.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png">
<meta name="application-name" content="L&amp;F">
<meta name="apple-mobile-web-app-title" content="L&amp;F">
```

---

## `public/kiosk.html`

Replace the existing `<link rel="manifest" ...>` line (right now line 4) with this block.

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/icons/icon-48.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="L&amp;F Desk">
<meta name="theme-color" content="#005EBB">
```

`apple-mobile-web-app-capable` is only there for iPads on iOS 16.3 and older; newer iOS takes the
`display: standalone` from the manifest. Keep it — the kiosk iPad may be on an older build.

---

## `public/admin.html`

Insert after `<title>L&amp;F · Admin</title>` (line 3). No manifest here on purpose: the admin
page is a hidden back-of-house tool, and giving it a manifest link would make the *public* PWA
installable straight from the admin tab.

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png">
<meta name="theme-color" content="#005EBB">
```

---

## What is deliberately *not* here

- **No `rel="icon" type="image/svg+xml"`.** Chrome would prefer the SVG for the tab and render
  the master at 16 px, which is softer than the optically corrected 16 px PNG. The SVG is the
  scalable master; the raster chain is tuned for screens.
- **No `rel="mask-icon"`.** Safari's pinned-tab mask needs a single-colour, alpha-only SVG; the
  coloured master would render as a solid blob. Not worth a second vector file for a dormant
  feature.
- **No `msapplication-*` tags.** Legacy Edge/IE tiles are dead; Windows uses the manifest icons.
- **maskable / monochrome PNGs** are consumed by Chromium/Firefox through `manifest.webmanifest`
  only; they must not be linked from HTML.

---

## Asset inventory

| File | Size | Purpose | Notes |
|---|---|---|---|
| `favicon.ico` | 16 / 32 / 48 | browser tabs, bookmarks | 3 frames, exact PNG renders, not resampled |
| `icons/icon-16.png` | 16×16 | tab favicon | optical cut (heavier tag frame) |
| `icons/icon-32.png` | 32×32 | tab favicon, HiDPI | optical cut |
| `icons/icon-48.png` | 48×48 | Windows shortcut icon | master |
| `icons/icon-64.png` | 64×64 | manifest size ladder | master |
| `icons/icon-96.png` | 96×96 | manifest shortcut icons | master |
| `icons/icon-128.png` | 128×128 | manifest size ladder | master |
| `icons/icon-144.png` | 144×144 | manifest size ladder | master |
| `icons/icon-192.png` | 192×192 | manifest `purpose: any` | master |
| `icons/icon-256.png` | 256×256 | manifest size ladder | master |
| `icons/icon-384.png` | 384×384 | manifest size ladder | master |
| `icons/icon-512.png` | 512×512 | manifest `purpose: any` | master |
| `icons/apple-touch-icon-180.png` | 180×180 | iOS home screen | **opaque** full-bleed deep blue, square corners (iOS masks them) |
| `icons/maskable-192.png` | 192×192 | Android adaptive / maskable | opaque, mark inside the central 80% safe circle |
| `icons/maskable-512.png` | 512×512 | Android adaptive / maskable | opaque, mark inside the central 80% safe circle |
| `icons/icon-monochrome.png` | 512×512 | Android themed icons | white only, transparent ground |
| `icons/icon-master.svg` | 1024 | vector master | transparent corners, all sizes derive from it |
| `icons/_preview.png` | — | visual QA sheet | light/dark comparison, not shipped to users |

## Icon design

Deep-blue rounded square (`#00458A`, 82% of the canvas), a white locker slot-tag outline
(`#FBFDFF`, bottom-right corner clipped at 45°), and the slot number `07` in IBM Plex Mono Bold
outlined to paths. Two elements plus one glyph — nothing that disappears at 16 px beyond the
digits, which are bold enough to read as a slot number at arm's length.

## After integrating

1. `python -m http.server --directory public 8123` and open `http://localhost:8123/` — check the
   tab favicon and the manifest in DevTools → Application → Manifest (no icon warnings).
2. On an iPad: Share → Add to Home Screen, confirm the icon is not letterboxed or translucent.
3. Chrome Android: DevTools remote inspection → Application → Manifest → *Installability* shows
   the maskable icon in the "maskable" section and the monochrome icon under themed icons.
4. **Bump the cache name in `sw.js` (`CACHE = 'lf-v…'`) in the same release.** The service worker
   is cache-first for `png`/`ico`, and `/icons/icon-192.png` + `/icons/icon-512.png` changed content
   under the same URLs — installed clients need a fresh cache to show the new mark.
5. The master is `icons/icon-master.svg`; every raster was rendered from it by Chromium at the
   exact target size (16 px and 32 px from a +2% frame optical cut). If the mark ever changes,
   re-render the whole set — do not scale one PNG.
