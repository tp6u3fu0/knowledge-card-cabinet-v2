import path from "node:path";
import { spawn } from "node:child_process";

const command = process.argv[2] ?? "build";
const executable = path.resolve("node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
// `npm run dev` serves the frontend with HMR and proxies to the local API
// started separately by `npm run dev:api`, which listens on these defaults.
const devDefaults = command === "dev"
  ? {
      API_INTERNAL_URL: process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000",
      API_INTERNAL_TOKEN: process.env.API_INTERNAL_TOKEN ?? process.env.KCC_API_TOKEN ?? "kcc-local-dev-token",
    }
  : {};

const child = spawn(executable, [command, ...process.argv.slice(3)], {
  env: {
    ...process.env,
    ...devDefaults,
    WRANGLER_LOG_PATH: path.resolve(".wrangler", "wrangler.log"),
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
