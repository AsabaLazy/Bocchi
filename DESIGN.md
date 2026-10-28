---
name: bocchi-design
description: Bocchi settings panel and toolbar popup in Chromium; monochrome zinc surfaces with light and dark themes, compact controls, and no decorative marketing chrome.
version: 035d081
---

# Bocchi Design

## 1. Scope and priority

Applies to `panel/` and `popup/`. It does not cover `docs/`, `store-assets/`, or the GitHub README.

Conflicts resolve in this order: accessibility, usability, product facts, existing tokens and components, brand expression, decoration.

## 2. Brand and readers

Bocchi should read as a quiet instrument panel, not a landing page. The interface is monochrome, dense, and low-chrome; hierarchy comes from spacing, contrast, and borders. One memorable surface is allowed: the timezone map. Everything around it stays quiet.

Readers are privacy-conscious desktop users, including people who understand browser APIs but do not want to tune a filter language. The UI therefore uses short Chinese labels, familiar switch controls, and on-demand help instead of always-visible explanations.

## 3. Page structure

**Settings shell.** A centered `1060px` surface with `26px 24px 64px` outer padding. The masthead holds the brand, theme button, reset button, and global shield. Below it, a `188px` navigation column and a flexible content column sit in a two-column grid with a `32px` gap. Each view starts with one title and an optional help trigger, followed by a flat option stack. At `760px` and below, the columns stack and navigation wraps.

**Toolbar popup.** A `350px` panel with `10px 16px` padding. Order: header, global control, current-site control, module list, full-settings action. There is no section heading above the module list; the rows explain themselves.

**Long list.** Font rows are `48px` tall and use `content-visibility: auto`. Rows keep one left selection column, one action column, and one flexible name column.

## 4. Visual rules

### Typography

- Family: `"Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif`.
- Settings body: `14px`; popup body: `13px`; both use `line-height: 1.5`.
- Brand: `14px / 600`; section title: `20px / 600`; popup title: `13px / 600`.
- Option labels: `13px / 500`. Navigation: `13px`. Secondary status: `11.5px–12px`.
- Do not introduce a second typeface. Do not use all caps for labels.

### Color

| Role | Dark | Light |
| --- | --- | --- |
| Page background | `#09090b` | `#fafafa` |
| Surface | `#111113` | `#ffffff` |
| Raised surface | `#18181b` | `#f4f4f5` |
| Border | `#27272a` | `#e4e4e7` |
| Soft border | `#232327` | `#ececef` |
| Primary text | `#fafafa` | `#09090b` |
| Muted text | `#b4b4bc` | `#5f5f68` |
| Faint text | `#8a8a93` | `#7c7c85` |
| Active control | `#e5e5e5` | `#09090b` |
| Active foreground | `#171717` | `#fafafa` |
| Selected background | `#3f3f42` | `#f5f5f5` |
| Hover background | `#202024` | `#e6e6ea` |
| Focus ring | `#a1a1aa` | `#8a8a8a` |

Popup uses its own token names in `popup/popup.css`; the values map to the same zinc roles. Dark is the default. Light is selected through `data-theme="light"` on `<html>`.

### Shape and surface

- Radius: `10px` for cards and panels, `8px` for controls and small surfaces.
- Shadow: `0 1px 2px rgba(0,0,0,.30)` dark, `0 1px 2px rgba(0,0,0,.04)` light.
- Borders carry hierarchy; do not add decorative gradients, glow, or multiple nested cards.
- Surfaces use one border and one shadow at most. Rows inside a stack use only a divider.

### Spacing and controls

- Control heights: `36px` large, `32px` medium, `28px` small.
- Page header controls: theme button `36 × 36px`; text buttons `121 × 36px`.
- Switch: `34 × 20px`, `14px` thumb, fully rounded track.
- Option rows: `12px 14px`; card stacks use `0` gap and shared borders.
- Masthead action gap: `8px`.

### States and motion

- Hover changes background or text contrast; it never moves layout.
- Focus uses a `2px` ring with `2px` offset, or a parent `focus-within` ring for search inputs.
- Disabled controls lower contrast and remove pointer actions; they do not fake an enabled state.
- Motion is limited to `background`, `border-color`, `color`, `opacity`, and small `transform` changes over `0.15s–0.2s`. `prefers-reduced-motion: reduce` disables transitions and animation.
- No page-load entrance animations.

### Icons

- Inline SVG, `14px–18px`, `2px` stroke, `currentColor`.
- Icon-only buttons need an accessible name. Decorative SVG needs `aria-hidden="true"`.

## 5. Available primitives

Pages reuse the core primitives below and the existing page-specific classes. Do not add a parallel component system.

| Primitive | Implementation | Purpose | Constraint |
| --- | --- | --- | --- |
| Settings container | `.settings-shell` / `.shell` | Centered settings width and page padding | Do not add another max-width wrapper |
| Masthead | `.masthead`, `.masthead-actions` | Brand and global actions | Theme, reset, and shield share one row on desktop |
| Theme button | `.icon-btn` | Cycle system, dark, and light | 36px square; accessible name required |
| Header actions | `.reset-btn`, `.status-pill` | Reset and global shield | Both are 36px high; text actions share 121px width |
| Navigation | `.settings-nav`, `.nav-item` | View switching | Selected item uses background only; no extra marker |
| View header | `.view-head`, `.view-title` | Section title and optional help | Exactly one `h2` per view |
| Help trigger | `.help-trigger`, `.help-popover` | On-demand explanation | Help content belongs here, not under every switch |
| Option stack | `.view-options-stack`, `.opt-row` | Grouped settings rows | Flat stack; no nested cards |
| Switch | `.switch` | Boolean setting | Label wraps the control; 34×20 track |
| Segmented control | `.mode-seg`, `.mode-btn` | Two-state mode choice | Text must state the mode without a second label |
| Text input | `.bypass-input` | Domain/URL entry | `13px`, 36px height, visible focus |
| Action button | `.sel-btn` | Secondary actions | Sentence-style label; shared hover/focus |
| Status | `.bypass-status`, `[role="status"]` | Async result feedback | Use `aria-live="polite"` |
| Skip link | `.skip-link` | Jump to settings content | Visible only on keyboard focus |
| Popup container | `.popup-container` | Popup width and vertical rhythm | Fixed 350px content width |
| Popup card | `.card` | Grouped popup controls | One border; no nested card |
| Popup module row | `.module-item` | Compact toggle row | One label and one switch; no subtitle |
| Popup footer action | `.btn-panel` | Open full settings | Keep one primary action |

Extension boundary: new page-specific selectors must be scoped to the page root. They may not change published primitives, add color literals outside `:root`, or introduce a parallel component library.

## 6. Copy and number formats

- UI copy is Chinese-first. Use concise labels, not implementation narration.
- Buttons start with a verb: `添加`, `导出设置`, `恢复默认`.
- Do not add a subtitle to explain a control that the label and layout already explain.
- API names and technical caveats belong in the help popover, not the primary label.
- Use `…` for loading and truncated placeholders. Use tabular numerals for clocks, counts, and coordinates.
- Do not use exclamation marks, marketing adjectives, or exclamation-style status copy.

## 7. Anti-patterns

- Do not add explanatory paragraphs under settings sections. Use the title, rows, and help trigger.
- Do not use cards inside cards or decorative icon tiles.
- Do not add a second active indicator to navigation. Background or rule, not both.
- Do not use gradients, glow, colored accents, or more than one shadow role.
- Do not use pill labels for ordinary metadata.
- Do not center a hero or marketing card in the settings surface.
- Do not introduce font sizes, weights, colors, radii, or spacing outside the tokens in this file.
- Do not let narrow navigation scroll horizontally and clip labels; wrap instead.
- Do not leave an icon-only button without an accessible name.
- Do not put implementation terms such as `getImageData` in a primary control label.

## 8. Implementation and integration

- Settings styles: `panel/panel.css`; popup styles: `popup/popup.css`.
- Theme switching: `data-theme` on `<html>`, persisted as `theme` in `chrome.storage.local`. Resolve `system` with `prefers-color-scheme`; dark is the default.
- Fonts are system fonts only; no webfont loading or network font requests.
- Responsive breakpoint: `760px`. Navigation wraps; content becomes one column.
- Reuse the existing inline SVG icon language; do not add an icon dependency.
- `color-scheme` follows the active theme. Native selects keep explicit background and text colors.

## Glossary

- **Settings shell** — the full-page options surface with a left navigation column.
- **View** — one section of the settings shell, selected by the navigation.
- **Option row** — one labeled control inside a bordered stack.
- **Module row** — one compact toggle inside the popup.
- **Masthead** — the top row containing brand and global actions.
