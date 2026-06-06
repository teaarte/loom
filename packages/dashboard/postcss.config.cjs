// PostCSS for the dashboard's Mantine layer. `postcss-preset-mantine` provides
// the `light-dark()` helper, `rem()`/`em()` functions, and the responsive/color
// mixins Mantine components and our CSS-modules use; `postcss-simple-vars`
// exposes the breakpoint variables those mixins read. Build-time only — the
// published package ships the prebuilt `dist/`, so these never reach a consumer.
//
// A `.cjs` file so it is read as CommonJS regardless of the package's
// `"type": "module"` (PostCSS loads its config with `require`).
module.exports = {
  plugins: {
    "postcss-preset-mantine": {},
    "postcss-simple-vars": {
      variables: {
        "mantine-breakpoint-xs": "36em",
        "mantine-breakpoint-sm": "48em",
        "mantine-breakpoint-md": "62em",
        "mantine-breakpoint-lg": "75em",
        "mantine-breakpoint-xl": "88em",
      },
    },
  },
};
