import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "@sortfm/contracts/client";
import App from "./App";
import "./styles.css";

// Local development uses Vite's /api proxy. Only this public origin enters a production build.
const client = createApiClient({
  baseUrl: import.meta.env.PROD ? import.meta.env.VITE_API_ORIGIN : undefined,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
