import { spawn } from "node:child_process";
import { platform } from "node:os";

const isWindows = platform() === "win32";
const command = isWindows ? "cmd.exe" : "npx";
const args = isWindows
  ? ["/d", "/s", "/c", "chcp 65001 >NUL && npx.cmd tsx watch src/index.ts"]
  : ["tsx", "watch", "src/index.ts"];

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    FORCE_COLOR: process.env.FORCE_COLOR ?? "1"
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
