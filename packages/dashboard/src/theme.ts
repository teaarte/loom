// The Mantine theme — loom's product identity: a warm light/dark surface with
// the brand's orange accent, a system sans for UI chrome, and the monospace
// stack reserved for what is genuinely code-shaped (paths, logs, ids, model
// refs). Color scheme is `auto` (follows the OS). Mantine styles are imported
// under `@layer mantine` (see `main.tsx`), so the few remaining unlayered
// overrides in `index.css` win without a specificity fight.

import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Code-shaped text only — not the UI default.
export const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// A 10-shade ramp around the brand accent (#ea580c at index 6 — the light
// primary). Dark mode uses the lighter index 4 so the accent stays readable
// on dark surfaces.
const loomOrange: MantineColorsTuple = [
  "#fff4ec",
  "#ffe8d9",
  "#ffd0b0",
  "#fdb284",
  "#f9935a",
  "#f47b3c",
  "#ea580c",
  "#d14e0a",
  "#b54409",
  "#8f3607",
];

export const theme = createTheme({
  primaryColor: "loomOrange",
  primaryShade: { light: 6, dark: 4 },
  colors: { loomOrange },
  fontFamily: SANS,
  fontFamilyMonospace: MONO,
  headings: { fontFamily: SANS, fontWeight: "700" },
  defaultRadius: "md",
  components: {
    Card: {
      defaultProps: { withBorder: true, radius: "md", padding: "md" },
    },
    Paper: {
      defaultProps: { withBorder: true, radius: "md" },
    },
    Badge: {
      defaultProps: { radius: "sm" },
    },
    Code: {
      styles: { root: { fontFamily: MONO } },
    },
  },
});
