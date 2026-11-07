import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConnectedRoot } from "./components/Connected";
import { createDemoClient, type DemoScenario } from "./data/demo-client";
import "./styles.css";

// Demo is an explicit entry point and never constructs a live client.
// Fault fixtures are opt-in and scoped to this local demo adapter.
const scenarioParam = new URLSearchParams(window.location.search).get(
	"scenario",
);
const scenario = ["empty", "load-error", "decision-error"].includes(
	scenarioParam ?? "",
)
	? (scenarioParam as DemoScenario)
	: undefined;
const isDemo =
	new URLSearchParams(window.location.search).get("mode") === "demo" ||
	!!scenario;
const client = isDemo ? createDemoClient({ scenario }) : null;
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{client ? <App client={client} /> : <ConnectedRoot />}
	</StrictMode>,
);
