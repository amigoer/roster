import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { MeProvider } from "./me";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <MeProvider>
        <App />
      </MeProvider>
    </I18nProvider>
  </StrictMode>,
);
