import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Mantine's stylesheets wrapped in `@layer mantine` — layered styles lose to
// unlayered ones regardless of import order, so the few legacy CSS-module
// overrides (and `index.css`) win cleanly.
import "@mantine/core/styles.layer.css";
import "@mantine/notifications/styles.layer.css";

import { App } from "./App.js";
import { theme } from "./theme.js";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <ColorSchemeScript defaultColorScheme="auto" />
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-right" autoClose={3500} />
      <App />
    </MantineProvider>
  </StrictMode>,
);
