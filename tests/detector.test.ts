import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTestCommands } from "../src/testing/detector.js";

const tmp = join(process.cwd(), "data", "test-detector");

describe("detectTestCommands", () => {
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("detects node package scripts", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "vite build"
        }
      })
    );

    expect(detectTestCommands(tmp)).toEqual([
      { label: "typecheck", command: "npm run typecheck" },
      { label: "test", command: "npm test" },
      { label: "build", command: "npm run build" }
    ]);
  });
});
