import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import appConfig from "./vite.config";

// Build the design prototype separately; the working app entry stays unchanged.
export default mergeConfig(appConfig, defineConfig({
  build: {
    outDir: "dist-draft",
    rollupOptions: { input: fileURLToPath(new URL("./draft.html", import.meta.url)) },
  },
}));
