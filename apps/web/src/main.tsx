import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createDemoClient, type DemoScenario } from "./data/demo-client";
import "./styles.css";

// B1 is local demo only. B2 can inject the shared HTTP client through App's client prop.
// Fault fixtures are opt-in and scoped to this local demo adapter.
const scenarioParam = new URLSearchParams(window.location.search).get(
	"scenario",
);
const scenario = ["empty", "load-error", "decision-error"].includes(
	scenarioParam ?? "",
)
	? (scenarioParam as DemoScenario)
	: undefined;
const client = createDemoClient({ scenario });
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App client={client} />
	</StrictMode>,
);
