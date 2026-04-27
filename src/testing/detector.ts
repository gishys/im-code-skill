import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DetectedCommand {
  label: string;
  command: string;
}

export function detectTestCommands(projectDir: string): DetectedCommand[] {
  const commands: DetectedCommand[] = [];
  const packageJsonPath = join(projectDir, "package.json");
  if (existsSync(packageJsonPath)) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.typecheck) commands.push({ label: "typecheck", command: "npm run typecheck" });
    if (pkg.scripts?.lint) commands.push({ label: "lint", command: "npm run lint" });
    if (pkg.scripts?.test) commands.push({ label: "test", command: "npm test" });
    if (pkg.scripts?.build) commands.push({ label: "build", command: "npm run build" });
    return commands;
  }
  if (existsSync(join(projectDir, "pom.xml"))) return [{ label: "test", command: "mvn test" }];
  if (existsSync(join(projectDir, "build.gradle")) || existsSync(join(projectDir, "build.gradle.kts"))) {
    return [{ label: "test", command: "gradle test" }];
  }
  if (existsSync(join(projectDir, "go.mod"))) return [{ label: "test", command: "go test ./..." }];
  if (existsSync(join(projectDir, "pyproject.toml")) || existsSync(join(projectDir, "requirements.txt"))) {
    return [{ label: "test", command: "python -m pytest" }];
  }
  if (existsSync(join(projectDir, "Cargo.toml"))) return [{ label: "test", command: "cargo test" }];
  return [];
}
