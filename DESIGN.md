---
version: "1.0"
name: "EVA Market Intelligence"
description: "A dark-first, data-legible design system for EVA's market-data infrastructure, historical chart training, review community, and operational tools. Near-black green-tinted surfaces, a restrained mint brand signal, precise hairlines, readable financial numerics, and calm technical typography create an interface that feels trustworthy, engineered, and focused rather than speculative or promotional."

colors:
  brand-primary: "#59D6AD"
  brand-bright: "#76E1BD"
  brand-deep: "#168B68"
  brand-soft: "rgba(89, 214, 173, 0.10)"
  on-brand: "#061410"
  canvas: "#07110F"
  canvas-deep: "#050706"
  surface-1: "#091713"
  surface-2: "#0D1D18"
  surface-3: "#11251E"
  ink: "#E9F3EF"
  ink-strong: "#F4FAF7"
  ink-muted: "#82958E"
  ink-soft: "#566D64"
  hairline: "rgba(151, 199, 183, 0.14)"
  hairline-strong: "rgba(151, 199, 183, 0.26)"
  market-up: "#32C48D"
  market-down: "#ED806C"
  market-neutral: "#93A39D"
  warning: "#E5B65E"
  info: "#75AEF0"
  focus: "#76E1BD"
  overlay: "rgba(1, 7, 5, 0.76)"
  light-canvas: "#F4F7F4"
  light-surface-1: "#FBFDFB"
  light-surface-2: "#FFFFFF"
  light-ink: "#12231D"
  light-muted: "#64766F"
  light-hairline: "rgba(35, 79, 64, 0.12)"

typography:
  display-xl:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "64px"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-3.2px"
  display-lg:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "48px"
    fontWeight: 650
    lineHeight: 1.06
    letterSpacing: "-2.1px"
  heading-xl:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 650
    lineHeight: 1.16
    letterSpacing: "-1px"
  heading-lg:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.5px"
  heading-md:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.2px"
  body-lg:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.7
  body-md:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.2
  mono-label:
    fontFamily: "'DM Mono', 'SFMono-Regular', Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "1.5px"
  code:
    fontFamily: "'DM Mono', 'SFMono-Regular', Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.65
  number-lg:
    fontFamily: "'IBM Plex Mono', 'DM Mono', ui-monospace, monospace"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.1
  number-md:
    fontFamily: "'IBM Plex Mono', 'DM Mono', ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.35

spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  xxxl: "48px"
  section: "80px"

rounded:
  none: "0px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "9999px"
  full: "50%"
---

# EVA Design System

## 1. Design intent

EVA turns complex market data into a stable language for people, software, and AI agents. The interface must therefore feel legible, calm, exact, and operational. It must never resemble a casino, a hype-driven crypto promotion, or a guaranteed-return product.

The visual system combines four ideas:

1. **Engineered clarity** — hierarchy comes from typography, alignment, surface lift, and hairlines.
2. **Market legibility** — prices, candles, dates, provenance, warnings, and data state remain readable under density.
3. **Restrained identity** — mint green is a scarce brand signal, not a decorative wash.
4. **Reflective training** — Trainer supports observation and review rather than rewarding prediction or simulated profit.

The default experience is dark. Light mode is a fully supported reading preference, not a different brand.

## 2. Brand atmosphere

- Near-black canvases have a subtle green undertone; avoid neutral charcoal that makes the product feel generic.
- Use one mint family for identity, focus, selected navigation, primary progress, and carefully chosen calls to action.
- Use technical monospace sparingly for instrument IDs, exchange codes, timestamps, command examples, compact status, and numeric data.
- Use Chinese-capable sans-serif typography for interface and community content.
- Data is the visual hero. Charts, terminal output, records, and provenance replace decorative photography.
- Interfaces are confident but quiet: low radius, thin lines, limited shadows, precise spacing.

## 3. Color policy

### Brand color

`brand-primary` is used for:

- primary action backgrounds when the action is safe and reversible;
- active navigation and selected controls;
- keyboard focus rings;
- progress and live connection signals;
- small identity accents and the EVA mark.

Do not use brand green for large decorative backgrounds or every icon. Most of the interface should remain ink, muted green-gray, and near-black.

### Market direction is separate from brand

Brand green and price-up green are different tokens even when visually related.

- `market-up`: positive price movement only.
- `market-down`: negative price movement, destructive consequence, or loss only when context makes the meaning explicit.
- `market-neutral`: unchanged or unavailable direction.

Never communicate market direction by color alone. Pair it with `+`/`−`, an arrow, a label, or candle direction. Do not color a primary submit button with `market-up`.

### Light mode mapping

- `canvas` → `light-canvas`
- `surface-1` → `light-surface-1`
- `surface-2` → `light-surface-2`
- `ink` → `light-ink`
- `ink-muted` → `light-muted`
- `hairline` → `light-hairline`
- `brand-primary` becomes `brand-deep` for text, focus, and thin strokes requiring contrast.

## 4. Typography

### Roles

- Display typography is reserved for the public website, onboarding, major empty states, and section openers.
- Product screens use `heading-lg` and smaller; never place a 48–64px marketing heading above a dense chart or table.
- Community posts use `body-md` with generous line height and a maximum reading width of 680px.
- Commands, canonical instrument IDs, provider codes, and timestamps use `code` or `mono-label`.
- Prices and market statistics use `number-*` with `font-variant-numeric: tabular-nums lining-nums`.

### Chinese typography

- Default Chinese fallback: `Noto Sans SC`, then `PingFang SC`, then system sans.
- Do not apply extreme negative tracking to Chinese characters.
- English display text may tighten tracking; mixed Chinese/English headings should use a milder value.
- Body text must not be smaller than 14px on desktop or mobile.

## 5. Layout and density

### Containers

- Marketing maximum: 1180–1280px.
- Community reading maximum: 1120px overall; 680px for primary prose.
- Chart training workspace: 1360–1440px, with an edge-to-edge option on large displays.
- Admin workspace: up to 1440px with fixed navigation and dense tables.
- Desktop gutters: 24–32px. Mobile gutters: 15–18px.

### Product grid

- Prefer a 12-column grid.
- Training desktop uses an 8/4 or 9/3 split: chart workspace plus observation/review rail.
- Admin desktop uses fixed 220–248px navigation plus flexible content.
- Feed cards are one column on mobile and may use two columns only when chart previews retain a readable aspect ratio.

### Density

- Marketing sections: 80–120px vertical rhythm.
- Product sections: 24–32px.
- Table rows: 44–52px.
- Toolbars: 40–48px.
- Compact tags and chart controls may use 28–32px height but must not become primary touch targets.

## 6. Shape and elevation

- Buttons and inputs: 6–8px radius.
- Standard product cards: 10–12px radius.
- Large chart frames and modals: no more than 16px.
- Pills are limited to tags, filters, status, and segmented selection.
- Avoid large 20–32px consumer-app cards.

Elevation hierarchy:

1. **Level 0** — canvas, no shadow.
2. **Level 1** — surface contrast plus `hairline`; default for cards, tables, and controls.
3. **Level 2** — `0 16px 44px rgba(0,0,0,.22)`; menus, floating tooltips, sticky composer.
4. **Level 3** — `0 28px 80px rgba(0,0,0,.38)` plus an inset hairline; modal only.

No glassmorphism. Backdrop blur is permitted only for sticky navigation and overlays when content remains readable.

## 7. Core components

### Navigation

`top-nav`

- 64–72px tall, sticky when useful.
- Canvas at 88–96% opacity with a bottom hairline.
- EVA mark and product name left; primary routes centered or adjacent; account actions right.
- Active state uses mint text plus a 2px underline or small solid indicator, never a glowing pill.

`admin-side-nav`

- 220–248px wide.
- Group labels use `mono-label` and `ink-soft`.
- Active row uses `brand-soft`, `brand-primary`, and a 2px leading rail.

### Buttons

`button-primary`

- Background `brand-primary`, text `on-brand`, height 40–44px, radius 8px.
- Hover uses `brand-bright`; pressed uses `brand-deep` with light text.
- Use for one dominant action per region.

`button-secondary`

- Background `surface-2`, text `ink`, 1px `hairline`, height 40px.
- Hover lifts to `surface-3` and `hairline-strong`.

`button-ghost`

- Transparent, text `ink-muted`; hover uses `brand-soft` and `ink`.

`button-danger`

- Use a restrained outline by default. Filled `market-down` is reserved for a confirmed destructive action.

### Inputs and filters

- Input background `surface-1`, 1px `hairline`, radius 8px, minimum height 40px.
- Focus: 2px `focus` ring at 60% opacity and no unrelated glow.
- Error uses `market-down` plus explicit helper text.
- Filter chips may be pills; selected chips use `brand-soft` rather than a full green fill.

### Cards

`feature-card`

- `surface-1`, hairline, 12px radius, 24px padding.
- No default shadow.

`review-card`

- Contains author, market/instrument context, compact chart preview, before/after review copy, tags, and interaction counts.
- The chart preview is content, not a decorative header.
- Keep disclaimers and provenance visible but subordinate.

`empty-state`

- Use concise writing, one small technical illustration or grid signal, and at most one primary action.
- Never use celebratory trading imagery, coins, rockets, trophies, or profit claims.

## 8. Market data and charts

`market-chart`

- Background `canvas-deep` or `surface-1`.
- Grid lines use `hairline` at low opacity.
- Rising candles use `market-up`; falling candles use `market-down`.
- Wick width, candle body, and crosshair must remain visible at common zoom levels.
- Axis labels use `number-md` or 11–12px mono, with tabular numerics.
- Current selection may use `warning` for a cut point or training boundary; do not reuse market colors.
- Hidden future data must not appear in indicators, summaries, thumbnails, or accessible labels.

`chart-toolbar`

- One row where space permits: interval, indicators, drawing/viewport controls, theme, reset.
- Secondary controls use compact outline or ghost treatments.
- Group related controls with dividers rather than separate floating cards.

`price-value`

- Align decimals and units.
- Use `number-lg` for the focal price and `number-md` for supporting values.
- Preserve source precision; never visually round in a way that changes meaning.

`data-table`

- Header 36–40px, rows 44–52px.
- Right-align numeric columns; left-align identifiers and names.
- Sticky header is preferred for long datasets.
- Use hairline row separation, not a card around every row.
- Hover is a surface tint. Selected state combines tint, leading indicator, and accessible state.

## 9. Training workflow

`training-workspace`

- Desktop: chart left, observation/review rail right.
- The primary task sequence is explicit: observe → record prior judgment → reveal → revise → save review.
- Reveal controls should feel like playback tools, not buy/sell controls.
- Progress uses neutral steps and mint completion; never grade a subjective judgment as green/red correctness.

`observation-composer`

- Use clear sections for “事前判断” and “事后复盘”.
- Draft state and save state must be explicit.
- Tags are secondary metadata and should not compete with the writing surface.
- A failed save preserves user input and provides a visible retry path.

`reveal-controls`

- Previous/next candle, autoplay, speed, and pause form one compact control group.
- The reveal action may use `brand-primary`; destructive or market-direction colors are forbidden.
- Display the remaining hidden-bar count without revealing dates or prices.

## 10. Community

- Favor calm editorial reading over social-media engagement pressure.
- Likes, collections, comments, and follower counts are muted utilities, not oversized metrics.
- Author identity and publication status are clear.
- Every public review surface can show: “历史行情观点，不构成投资建议”.
- Do not use badges that imply verified profitability, strategy correctness, or official endorsement.

## 11. Marketing surfaces

- The public home page may use a faint 36–52px technical grid and one restrained radial mint glow.
- Hero imagery should be real product UI, chart structure, or CLI output—not abstract 3D coins.
- Display headings may reach 64–96px on wide screens when line length stays short.
- CTA hierarchy remains monochrome plus mint; do not introduce multiple campaign colors.
- Motion is limited to connection signals, cursor blink, subtle chart/data emergence, and restrained hover transitions.

## 12. Responsive behavior

Breakpoints:

- Compact mobile: `< 480px`
- Mobile: `< 768px`
- Tablet: `768–1023px`
- Desktop: `1024–1439px`
- Wide workspace: `≥ 1440px`

Rules:

- Navigation collapses below 768px.
- Training mobile switches between “图表” and “记录” views rather than squeezing both columns.
- Chart controls move into a bottom sheet or overflow menu; reveal/play controls remain directly reachable.
- Data tables preserve the identifier and focal numeric value, hiding secondary columns behind row detail.
- Minimum primary touch target: 44×44px.
- Marketing grids collapse 3 → 2 → 1 columns.
- Community cards remain single-column below 1024px.

## 13. Accessibility and trust

- Meet WCAG AA contrast for text and functional states.
- Keyboard focus is always visible.
- All icon-only controls require accessible names and tooltips.
- Charts require a text summary or tabular alternative when the data is essential.
- Market-up/down, validation, and connection state cannot rely on color alone.
- Respect `prefers-reduced-motion`; remove animated signals that do not convey live state.
- Timestamps, source/provider, adjustment mode, interval, and stale-data warnings remain discoverable.

## 14. Imagery and iconography

- Use crisp line icons with 1.5–2px strokes and simple geometry.
- Prefer functional charts, UI captures, command lines, exchange codes, and data provenance diagrams.
- Photography is rare and belongs only to editorial/community stories where a real person is the subject.
- Avoid crypto coin piles, rockets, bull/bear mascots, neon trading floors, holographic dashboards, glass cards, and AI brain imagery.

## 15. Do and do not

### Do

- Let market data, review writing, and provenance carry the interface.
- Keep mint scarce and meaningful.
- Separate brand, market direction, warning, and destructive semantics.
- Use tabular numerics and preserve decimal precision.
- Build depth with surfaces and hairlines before shadows.
- Preserve a clear recovery path for network and save failures.
- Treat public reviews as user opinions rather than recommendations.

### Do not

- Do not style EVA as an exchange, casino, brokerage, or profit leaderboard.
- Do not fill the page with green gradients or glowing borders.
- Do not use green/red to grade the user's subjective judgment.
- Do not make every section a rounded floating card.
- Do not place oversized marketing typography inside chart workspaces.
- Do not hide source, precision, stale state, or risk boundaries for visual cleanliness.
- Do not use proprietary brand fonts or visual trademarks from reference products.

## 16. Agent implementation guide

Before changing UI:

1. Identify the surface: marketing, product, chart, community, or admin.
2. Map every color to a semantic token; do not introduce unnamed hex values.
3. Reuse the typography, spacing, and radius scales.
4. Verify brand green is not being confused with market-up.
5. Implement hover, focus, pressed, disabled, loading, error, empty, and stale-data states.
6. Check mobile collapse and keyboard navigation.
7. Review the result against the Do/Do not section.

Prompt example:

> Build an EVA historical market training workspace using this DESIGN.md. Use a dark 9/3 chart-and-review layout, restrained mint branding, separate up/down candle tokens, compact playback-style reveal controls, and a calm observation composer. Preserve dense financial legibility. Do not use glassmorphism, crypto imagery, oversized cards, profit language, or decorative glow around data.

## 17. Known gaps

- Formal logo construction and clear-space rules are not yet defined.
- Chart indicator colors beyond the core semantic set need a tested multi-series palette.
- Email, notification, and share-card design are not yet specified.
- Native mini-program differences need a separate platform appendix.
- Motion timings need usability testing before becoming normative.
