import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { AppSettingsProvider } from "./components/settings/AppSettingsProvider";
import { ThemeProvider } from "./components/theme/theme-provider";
import "overlayscrollbars/overlayscrollbars.css";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AppSettingsProvider>
        <App />
      </AppSettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
