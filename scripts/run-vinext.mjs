import path from "node:path";
import { spawn } from "node:child_process";

const command = process.argv[2] ?? "build";
const executable = path.resolve("node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
const child = spawn(executable, [command, ...process.argv.slice(3)], {
  env: {
    ...process.env,
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
