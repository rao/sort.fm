import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { modelLabDev } from "./model-lab-dev";

export default defineConfig({
	plugins: [react(), modelLabDev()],
	resolve: {
		alias: { "#ui": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: {
		// Keep the private evidence file behind the guarded development middleware,
		// including Vite's root-relative and /@fs static paths.
		fs: {
			deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.local/**"],
		},
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: { "/api": "http://127.0.0.1:3001" },
	},
	preview: { host: "127.0.0.1", port: 5173, strictPort: true },
});
