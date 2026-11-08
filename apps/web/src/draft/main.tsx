import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DirectionProvider } from "#ui/components/foundations/direction/direction";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/vt323";
import "./draft.css";
import "./retro.css";
import "../styles/scrollbars.css";
import { Draft } from "./Draft";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<DirectionProvider locale="en-US">
			<Draft />
		</DirectionProvider>
	</StrictMode>,
);
