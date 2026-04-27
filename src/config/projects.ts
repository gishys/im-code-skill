import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import type { ProjectConfig } from "../types.js";

const repoSchema = z.object({
  repo: z.string().min(1),
  install: z.string().optional(),
  test: z.string().optional(),
  build: z.string().optional(),
  artifact_paths: z.array(z.string().min(1)).min(1)
});

const projectSchema = z.object({
  name: z.string().min(1),
  default_branch: z.string().min(1),
  frontend: repoSchema.optional(),
  backend: repoSchema.optional(),
  package: z.object({
    format: z.literal("zip"),
    name_template: z.string().min(1)
  }),
  auto_approve_rules: z
    .object({
      users: z.array(z.string()).optional(),
      task_types: z.array(z.enum(["feature", "bug"])).optional(),
      scopes: z.array(z.enum(["frontend", "backend"])).optional()
    })
    .optional()
});

const projectsSchema = z.object({
  projects: z.array(projectSchema).min(1)
});

export function loadProjectsConfig(path: string): ProjectConfig[] {
  const parsed = projectsSchema.parse(YAML.parse(readFileSync(path, "utf8")));
  const names = new Set<string>();
  for (const project of parsed.projects) {
    if (names.has(project.name)) {
      throw new Error(`Duplicate project name: ${project.name}`);
    }
    names.add(project.name);
    if (!project.frontend && !project.backend) {
      throw new Error(`Project ${project.name} must define frontend or backend repo`);
    }
  }
  return parsed.projects;
}

export function findProject(projects: ProjectConfig[], name: string): ProjectConfig {
  const project = projects.find((item) => item.name === name);
  if (!project) {
    throw new Error(`Unknown project: ${name}`);
  }
  return project;
}
