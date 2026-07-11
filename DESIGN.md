# Design

Visual contract for the outreach dashboard. Components are theme-agnostic: they
read only the semantic CSS variables below, so a mode is a set of token values
and nothing in a component hard-codes a color, font, or radius. One design
language (editorial) ships in two modes — `light` (base) and `dark` — switchable
at runtime via `data-theme` on the document root and persisted to localStorage.

## Visual theme / register
Product register, control-room feel. The data is the interface: real funnels,
real rows, no vanity hero metric. Each theme commits fully to one lane rather
than blending. Depth in dark themes comes from surface lightness, not shadow or
glow; light themes use hairline borders and at most one soft elevation shadow.

## Token contract (semantic — every component uses only these)
Surfaces and ink (elevation is lightness, not shadow):
- `--surface-0` page background · `--surface-1` panel · `--surface-2` raised/hover · `--surface-3` active/selected
- `--ink-1` primary text · `--ink-2` secondary · `--ink-3` muted/labels
- `--line` hairline border · `--line-strong` divider

Accent and signal (accent is ~10% of visual weight — actions, selection, focus only):
- `--accent` · `--accent-ink` (text on accent) · `--focus` (focus ring)
- Status, one meaning everywhere: `--st-approval` (needs a human), `--st-active`
  (in progress), `--st-waiting` (awaiting someone else), `--st-replied`,
  `--st-done`, `--st-failed`, `--st-idle`.

Type:
- `--font-display` (headings) · `--font-body` (prose, labels) · `--font-mono` (all numerals, timestamps, funnel counts, table figures — always `font-variant-numeric: tabular-nums`)
- Ramp (fixed rem, root 16px; themes may override h1/h2 only): `--text-caption` .75rem · `--text-meta` .8125rem · `--text-body` .9375rem · `--text-sub` 1.0625rem · `--text-h2` 1.375rem · `--text-h1` 1.75rem
- Weights: `--weight-normal` 400 · `--weight-medium` 500 · `--weight-semibold` 600

Shape and space:
- Radius: `--radius-1`, `--radius-2` (theme-set; Swiss = 0)
- Elevation: `--shadow-1` (theme-set; Instrument = none)
- Spacing scale (shared 4pt, px): `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 · `-12` 48 · `-16` 64
- Motion: `--ease` cubic-bezier(.2,.7,.2,1) (ease-out, no bounce) · `--dur` 180ms

## Themes

One design language — **editorial** — in two modes, `light` (the base) and
`dark`, switched via `data-theme` and toggled from the header. Serif display,
airy whitespace, deep calm teal-green accent, hairline structure. Depth is a soft
shadow in light and surface-lightness in dark. Shared: font-display
`ui-serif, Georgia, "Times New Roman", serif`; font-body system-ui; font-mono
`ui-monospace, Menlo, monospace`; --text-h1 2.125rem / --text-h2 1.5rem; radius 8px/12px.

### light (base · `data-theme='light'`, also the bare `:root` first-paint mirror)
Considered cool-neutral paper (NOT cream), generous whitespace.
- surface-0 `#f6f7f8` · 1 `#ffffff` · 2 `#eef0f2` · 3 `#e6e9ec`
- ink-1 `#1c2127` · 2 `#4c545e` · 3 `#7c8590` · line `#e2e6ea` · line-strong `#cfd5db`
- accent `#1f6b5c` (deep teal-green) · accent-ink `#ffffff` · focus `#1f6b5c`
- status: approval `#b5771c` · active `#2f6bb0` · waiting `#3a8391` · replied `#6f5aa6` · done `#2f8266` · failed `#b4483f` · idle `#7c8590`
- shadow-1 `0 1px 2px rgba(20,24,28,.06), 0 2px 8px rgba(20,24,28,.05)`.

### dark (`data-theme='dark'`)
Same language on a calm dark surface; depth by surface lightness. Accent/status
hues lifted for AA on dark. Accent sits in the band that reads as a link on dark
(≥4.5:1) yet, darkened 80% for the button fill, still clears 4.5:1 vs white ink.
- surface-0 `#16191d` · 1 `#1d2126` · 2 `#262b31` · 3 `#2f353c`
- ink-1 `#e9ebee` · 2 `#b3bac2` · 3 `#838b94` · line `rgba(255,255,255,.10)` · line-strong `rgba(255,255,255,.18)`
- accent `#3d9c85` (teal-green, lifted) · accent-ink `#ffffff` · focus `#5cc4aa`
- status: approval `#d99a3a` · active `#5b8dd9` · waiting `#4f9fae` · replied `#a692cc` · done `#4fae8e` · failed `#d0726b` · idle `#838b94`
- shadow-1 `0 6px 20px rgba(0,0,0,.45)`.

## Components (conventions — all antipattern-safe)
- **No side-tab borders** (never a colored `border-left/right`). Selection/active =
  raised `--surface-3` + a full 1px `--accent` border (or `--line-strong`), never
  an inset colored glow.
- **Status chip**: neutral `--surface-2` background, a dot in the status color,
  label in `--ink-2`. Never colored text on a colored fill (avoids gray-on-color).
- **Status badge** (campaign status): same, slightly larger.
- **Funnel bar**: proportional segments; fill is the status color at low alpha over
  the surface, the big count is `--font-mono` in the status color, label in `--ink-3`.
  No side stripe, no glow. Active segment raised + 1px accent ring; others dim to .5.
- **Panels**: one level only — never a card inside a card. The approvals queue is
  divided rows within one panel, not stacked cards. Group with spacing + `--line`
  dividers, not nested containers.
- **Tables**: hairline row dividers, `tabular-nums`, sortable headers, client
  pagination. Wide tables scroll inside an `overflow-x:auto` wrapper, never the page.
- **Elevation**: dark theme none; light themes `--shadow-1` OR a `--line` border,
  never a hairline border AND a wide diffuse shadow together.
- **Focus**: 2px `--focus` outline with offset on every interactive element.

## Layout
Single centered column (max-width ~1040px), 24px gutters. Page shell is CSS grid
with `grid-template-columns: minmax(0,1fr)` so wide tables scroll internally.
Responsive is structural: nav wraps, tables scroll, no fluid type. 44px min touch
targets; no body text under 14px; no horizontal page scroll at any width.

## Motion
`--dur` 180ms, `--ease` ease-out. Motion only conveys state (hover, focus,
selection, expand). No page-load choreography, no layout-property animation
(transform/opacity or `grid-template-rows` only), no bounce. `prefers-reduced-motion`
collapses all transitions to none.
