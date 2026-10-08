#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(__dirname, "..", "src", "index.ts");

const child = spawn("bun", [entrypoint], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  if (error && error.code === "ENOENT") {
    console.error("telegram-pi-gateway requires Bun. Install it from https://bun.sh before running this command.");
    process.exit(127);
  }

  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
