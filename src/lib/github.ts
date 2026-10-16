// Minimal GitHub REST client for opening a pull request with new files.
// Uses the Git Data API so text and binary files land in a single commit.

export interface GitHubConfig {
  token: string;
  repo: string; // "owner/name"
  baseBranch: string;
  apiUrl: string;
  label?: string;
}

export interface NewFile {
  path: string;
  /** utf-8 text or base64 data */
  content: string;
  encoding: 'utf-8' | 'base64';
}

export function githubConfigFromEnv(env = process.env): GitHubConfig | null {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) return null;
  return {
    token,
    repo,
    baseBranch: env.GITHUB_BASE_BRANCH || 'main',
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    label: env.GITHUB_PR_LABEL ?? 'story-submission',
  };
}

async function gh<T>(cfg: GitHubConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}/repos/${cfg.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'imconnected-submissions',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function openPullRequest(
  cfg: GitHubConfig,
  opts: { branch: string; files: NewFile[]; commitMessage: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  // 1. Tip of the base branch
  const ref = await gh<{ object: { sha: string } }>(cfg, 'GET', `/git/ref/heads/${encodeURIComponent(cfg.baseBranch)}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh<{ tree: { sha: string } }>(cfg, 'GET', `/git/commits/${baseSha}`);

  // 2. Upload blobs
  const tree = [];
  for (const f of opts.files) {
    const blob = await gh<{ sha: string }>(cfg, 'POST', '/git/blobs', { content: f.content, encoding: f.encoding });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 3. Tree + commit
  const newTree = await gh<{ sha: string }>(cfg, 'POST', '/git/trees', { base_tree: baseCommit.tree.sha, tree });
  const commit = await gh<{ sha: string }>(cfg, 'POST', '/git/commits', {
    message: opts.commitMessage,
    tree: newTree.sha,
    parents: [baseSha],
  });

  // 4. Branch + PR
  await gh(cfg, 'POST', '/git/refs', { ref: `refs/heads/${opts.branch}`, sha: commit.sha });
  const pr = await gh<{ number: number; html_url: string }>(cfg, 'POST', '/pulls', {
    title: opts.title,
    head: opts.branch,
    base: cfg.baseBranch,
    body: opts.body,
    maintainer_can_modify: true,
  });

  if (cfg.label) {
    await gh(cfg, 'POST', `/issues/${pr.number}/labels`, { labels: [cfg.label] }).catch(() => {});
  }
  return { number: pr.number, url: pr.html_url };
}
