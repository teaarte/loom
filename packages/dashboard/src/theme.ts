// The Mantine theme — tuned to keep loom's terminal identity through the UI-kit
// swap: a monospace base font (the prior console's `ui-monospace` stack) and a
// primary mapped to the existing steel-blue accent, so migrated Mantine
// components read as the same product as the not-yet-migrated CSS-module views.
// Color scheme is `auto` (follows the OS), matching the prior `prefers-color-
// scheme` behaviour. Mantine styles are imported under `@layer mantine` (see
// `main.tsx`), so the legacy CSS-modules win during the incremental migration
// without a specificity fight.

import { createTheme, type MantineColorsTuple } from "@mantine/core";

// The terminal monospace stack the dashboard has always used.
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// A 10-shade tuple around the prior accent (`#3b6ea5` light / `#6ea8e6` dark).
// Index 6 is the light primary shade (≈ the old accent); the lighter shades
// carry the dark-scheme accent.
const loomBlue: MantineColorsTuple = [
  "#ecf3fb",
  "#dae6f3",
  "#b2cae6",
  "#88acd9",
  "#6592ce",
  "#4f83c8",
  "#3b6ea5",
  "#356395",
  "#2c5380",
  "#22425f",
];

export const theme = createTheme({
  primaryColor: "loomBlue",
  // Lighter accent in dark mode (≈ the old `#6ea8e6`), the old accent in light.
  primaryShade: { light: 6, dark: 4 },
  colors: { loomBlue },
  fontFamily: MONO,
  fontFamilyMonospace: MONO,
  headings: { fontFamily: MONO, fontWeight: "700" },
  defaultRadius: "md",
});
