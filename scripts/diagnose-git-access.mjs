import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import YAML from "yaml";

const [, , repoArg, branchArg] = process.argv;

loadDotEnv(".env");

const target = repoArg
  ? { repo: repoArg, branch: branchArg ?? "main", source: "command line" }
  : readFirstProjectRepo();

if (!target?.repo) {
  console.error("No repository was provided and no repository was found in projects.yaml.");
  console.error("Usage: node scripts/diagnose-git-access.mjs <repo-url> [branch]");
  process.exit(2);
}

const repoInfo = parseGitHubRepo(target.repo);

console.log(`Repository: ${target.repo}`);
console.log(`Branch: ${target.branch}`);
console.log(`Source: ${target.source}`);
console.log("");

const sshResult = await run("git", ["ls-remote", "--heads", target.repo, target.branch], {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes"
});
reportGitResult("Git access with configured repo URL", sshResult, target.branch);

if (repoInfo) {
  await checkGitHubApi(repoInfo.owner, repoInfo.name);
  if (process.env.GITHUB_TOKEN) {
    const httpsRepo = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repoInfo.owner}/${repoInfo.name}.git`;
    const tokenResult = await run("git", ["ls-remote", "--heads", httpsRepo, target.branch], {
      GIT_TERMINAL_PROMPT: "0"
    });
    reportGitResult("Git access with GITHUB_TOKEN over HTTPS", tokenResult, target.branch);
  } else {
    console.log("[skip] GITHUB_TOKEN is not set, skipped HTTPS token Git check.");
  }
} else {
  console.log("[skip] Repository is not a github.com URL, skipped GitHub API/token checks.");
}

function readFirstProjectRepo() {
  if (!existsSync("projects.yaml")) {
    return undefined;
  }
  const config = YAML.parse(readFileSync("projects.yaml", "utf8"));
  for (const project of config.projects ?? []) {
    for (const scope of ["frontend", "backend"]) {
      const repo = project?.[scope]?.repo;
      if (repo) {
        return {
          repo,
          branch: project?.[scope]?.default_branch ?? project?.default_branch ?? "main",
          source: `projects.yaml:${project.name ?? "unnamed"}.${scope}`
        };
      }
    }
  }
  return undefined;
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    process.env[match[1]] = unquote(match[2].trim());
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseGitHubRepo(repo) {
  const trimmed = repo.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (ssh) {
    return { owner: ssh[1], name: basename(ssh[2]) };
  }
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+)$/i);
  if (https) {
    return { owner: https[1], name: basename(https[2]) };
  }
  return undefined;
}

async function checkGitHubApi(owner, repo) {
  if (!process.env.GITHUB_TOKEN) {
    console.log("[skip] GITHUB_TOKEN is not set, skipped GitHub API check.");
    return;
  }

  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "im-code-skill-git-diagnose"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[fail] GitHub API check could not connect: ${message}`);
    return;
  }

  if (response.ok) {
    const body = await response.json();
    console.log(`[ok] GitHub API token can access ${body.full_name}; default branch: ${body.default_branch}`);
    return;
  }

  const body = await response.text();
  const message = summarizeOutput(body);
  if (response.status === 401) {
    console.log("[fail] GitHub API rejected GITHUB_TOKEN: token is invalid or expired.");
  } else if (response.status === 403) {
    console.log("[fail] GitHub API returned 403: token exists but lacks permission, is SSO-blocked, or is rate-limited.");
  } else if (response.status === 404) {
    console.log("[fail] GitHub API returned 404: repository does not exist or this token has no access to it.");
  } else {
    console.log(`[fail] GitHub API returned ${response.status}: ${message}`);
  }
}

function reportGitResult(title, result, branch) {
  if (result.code === 0) {
    console.log(`[ok] ${title}: branch '${branch}' is visible.`);
    return;
  }

  const output = summarizeOutput(result.output);
  const lower = output.toLowerCase();
  if (lower.includes("permission denied")) {
    console.log(`[fail] ${title}: SSH authentication failed. Check private key, deploy key, GitHub account key, and repo permission.`);
  } else if (lower.includes("authentication failed") || lower.includes("could not read username")) {
    console.log(`[fail] ${title}: HTTPS authentication failed. Check GITHUB_TOKEN and token scopes/permissions.`);
  } else if (lower.includes("repository not found") || lower.includes("not found")) {
    console.log(`[fail] ${title}: repository not found or current credential has no access.`);
  } else if (lower.includes("couldn't connect") || lower.includes("failed to connect") || lower.includes("timed out")) {
    console.log(`[fail] ${title}: network/proxy connection to GitHub failed.`);
  } else {
    console.log(`[fail] ${title}: ${output}`);
  }
}

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ code: -1, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: -1, output: `${command} ${args.map(redact).join(" ")} timed out after 15 seconds` });
    }, 15000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function redact(value) {
  return String(value).replace(process.env.GITHUB_TOKEN ?? "___NO_TOKEN___", "[REDACTED]");
}

function summarizeOutput(output) {
  return String(output)
    .replaceAll(process.env.GITHUB_TOKEN ?? "___NO_TOKEN___", "[REDACTED]")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" | ");
}
