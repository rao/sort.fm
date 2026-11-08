import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DirectionProvider } from "#ui/components/foundations/direction/direction";
import "@fontsource-variable/bricolage-grotesque";
import "./draft.css";
import { Draft } from "./Draft";

createRoot(document.getElementById("root")!).render(
  <StrictMode><DirectionProvider locale="en-US"><Draft /></DirectionProvider></StrictMode>,
);
