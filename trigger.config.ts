import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_qowsarzrztfwudbbgety",
  runtime: "node",
  logLevel: "log",
  dirs: ["./src/trigger"],
  maxDuration: 300, // 5 minutes — tasks like deep-research and write-report need time
});
