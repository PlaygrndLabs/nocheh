# ADR-0180: The pixel brain logo and the logo's colours

<status>
Accepted on 2026-10-27. Refines the dashboard look in
[ADR-0145](0145-rebuilt-owner-dashboard.md).
</status>

<context>
The owner shared a pixel-art concept for the logo, a lavender brain with a dark
visor and two mint eyes over a "nocheh" pixel wordmark on navy, and asked for it
improved and made "compatible with our app design or make app design same it".
Three variants were shown with dashboard screenshots; the owner chose the brain
with the logo's colours.
</context>

<decision>
- The logo is the brain drawn on a pixel grid with crisp edges: a 23×19 brain
  with folds for large uses, and a 16×14 brain for 32 pixels and below, so each
  logo pixel is a whole number of screen pixels. The "nocheh" wordmark is drawn
  on the same kind of grid.
- Logo colours are fixed in both themes: lavender `#B69CF7`, folds `#8A6FDC`,
  visor navy `#0B1024`, eyes mint `#6EE7C8`, wordmark `#F4F1EA` on dark.
- The dashboard's semantic tokens follow the logo: a lavender accent, a navy
  dark mode with warm white text, and mint for confirmed success. Warning,
  failure and active-work colours keep their meanings.
- The dashboard navigation, the phone header and the mini app show the logo
  from `dashboard/ui/logo.tsx`. The dashboard and mini app favicon is an inline
  SVG data address, so no new asset route or proxy allowlist entry is needed.
- `docs/assets/logo` holds the README lockups, the mark, the app icon and a
  512-pixel Telegram bot picture for BotFather.
</decision>

<consequences>
- The old "ن" tile and the teal accent are gone.
- Changing the logo means redrawing the pixel grids; the components and the
  favicon carry the same paths.
</consequences>
