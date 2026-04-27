import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import archiver from "archiver";
import type { ProjectConfig, TaskRecord } from "../types.js";

export interface PackageResult {
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
}

export async function packageArtifacts(task: TaskRecord, project: ProjectConfig, repoArtifacts: string[], workspace: string): Promise<PackageResult> {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const name = project.package.name_template
    .replace("{project}", task.projectName)
    .replace("{scope}", task.scope)
    .replace("{taskId}", task.id)
    .replace("{timestamp}", timestamp);
  const outputDir = join(workspace, "artifacts");
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, name.endsWith(".zip") ? name : `${name}.zip`);

  await new Promise<void>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = createWriteStream(output);
    stream.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(stream);
    for (const artifact of repoArtifacts) {
      if (!existsSync(artifact)) {
        throw new Error(`Artifact path does not exist: ${artifact}`);
      }
      archive.directory(artifact, basename(artifact));
    }
    archive.finalize().catch(reject);
  });

  const info = await stat(output);
  return {
    path: output,
    name: basename(output),
    sizeBytes: info.size,
    sha256: await sha256File(output)
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}
