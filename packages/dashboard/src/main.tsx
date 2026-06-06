import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Mantine's stylesheet wrapped in `@layer mantine` — layered styles lose to
// unlayered ones regardless of import order, so the legacy CSS-modules (and
// `index.css`) override Mantine cleanly while views migrate one at a time.
import "@mantine/core/styles.layer.css";

import { App } from "./App.js";
import { theme } from "./theme.js";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <ColorSchemeScript defaultColorScheme="auto" />
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
);
