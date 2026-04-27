import { Octokit } from "@octokit/rest";

export interface CreatePullRequestInput {
  token?: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export async function createPullRequest(input: CreatePullRequestInput): Promise<string | undefined> {
  if (!input.token) {
    return undefined;
  }
  const octokit = new Octokit({ auth: input.token });
  const response = await octokit.pulls.create({
    owner: input.owner,
    repo: input.repo,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    draft: input.draft ?? true
  });
  return response.data.html_url;
}

export function parseGitHubRepoName(repoUrl: string): string {
  const sshMatch = repoUrl.match(/github\.com[:/][^/]+\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }
  const parts = repoUrl.replace(/\.git$/, "").split("/");
  return parts[parts.length - 1];
}
