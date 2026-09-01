import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);

/**
 * Git and GitHub operations for the agent.
 *
 * The agent works in a fresh clone under orchestrator/.agent-workspace rather than in the
 * running checkout: the demo service is live during a demo, and an agent editing the
 * files underneath it would be both unsafe and unrepresentative of how this runs in
 * production.
 */

const AGENT_NAME = process.env.AGENT_GIT_NAME || 'AI Engineering Agent';
const AGENT_EMAIL = process.env.AGENT_GIT_EMAIL || 'ai-agent@users.noreply.github.com';

function repoUrl({ withToken = false } = {}) {
  const base = `github.com/${config.github.repo}.git`;
  return withToken
    ? `https://x-access-token:${config.github.token}@${base}`
    : `https://${base}`;
}

async function git(dir, args) {
  const { stdout } = await exec('git', ['-C', dir, ...args], { maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Fresh shallow clone of the base branch. Returns the workspace path.
 */
export async function prepareWorkspace(incidentId) {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  const dir = path.join(config.workspaceDir, incidentId);
  await fs.rm(dir, { recursive: true, force: true });

  await exec('git', [
    'clone', '--quiet', '--depth', '1',
    '--branch', config.github.baseBranch,
    repoUrl(), dir,
  ], { maxBuffer: 20 * 1024 * 1024 });

  await git(dir, ['config', 'user.name', AGENT_NAME]);
  await git(dir, ['config', 'user.email', AGENT_EMAIL]);
  return dir;
}

export async function createBranch(dir, branch) {
  await git(dir, ['checkout', '-q', '-b', branch]);
  return branch;
}

/** What actually changed on disk, which is more trustworthy than what the model claims. */
export async function getChanges(dir) {
  const status = await git(dir, ['status', '--porcelain']);
  const files = status.split('\n').filter(Boolean).map((line) => line.slice(3).trim());
  const diffStat = files.length ? await git(dir, ['diff', '--stat']) : '';
  const diff = files.length ? await git(dir, ['diff']) : '';
  return { files, diffStat, diff };
}

export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

export async function pushBranch(dir, branch) {
  // The token lives in the push URL for this single call and is never written to
  // .git/config, so the workspace clone holds no credentials.
  await exec('git', ['-C', dir, 'push', '--quiet', repoUrl({ withToken: true }), `${branch}:${branch}`],
    { maxBuffer: 10 * 1024 * 1024 });
  return branch;
}

/**
 * Opens a pull request. If one already exists for the branch, returns that instead of
 * failing — reruns during a demo should be harmless.
 */
export async function openPullRequest({ title, body, head, base = config.github.baseBranch }) {
  const response = await fetch(`https://api.github.com/repos/${config.github.repo}/pulls`, {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({ title, body, head, base }),
  });

  if (response.status === 201) {
    const pr = await response.json();
    return { number: pr.number, url: pr.html_url, existing: false };
  }

  const text = await response.text();
  if (response.status === 422 && text.includes('A pull request already exists')) {
    const existing = await findOpenPullRequest(head);
    if (existing) return { ...existing, existing: true };
  }
  throw new Error(`GitHub PR creation failed (HTTP ${response.status}): ${text.slice(0, 400)}`);
}

async function findOpenPullRequest(head) {
  const owner = config.github.repo.split('/')[0];
  const response = await fetch(
    `https://api.github.com/repos/${config.github.repo}/pulls?head=${owner}:${head}&state=open`,
    { headers: githubHeaders() },
  );
  if (!response.ok) return null;
  const [pr] = await response.json();
  return pr ? { number: pr.number, url: pr.html_url } : null;
}

function githubHeaders() {
  return {
    authorization: `Bearer ${config.github.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'gsc-poc-orchestrator',
  };
}

/**
 * Startup check: confirms the token can actually push before a demo depends on it.
 *
 * `repo.permissions` is NOT usable for this — it reports the authenticated *user's*
 * rights on the repository, so a repo owner sees push:true even when the token itself
 * has no write access. Instead we attempt a ref creation with an all-zero sha: it can
 * never succeed, and the status code distinguishes the two cases. 403 means the token
 * lacks contents:write; 422 means the write was permitted and only the sha was invalid.
 */
export async function verifyGitHub() {
  const response = await fetch(`https://api.github.com/repos/${config.github.repo}`, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub check failed (HTTP ${response.status}) for ${config.github.repo}`);
  }
  const repo = await response.json();

  const probe = await fetch(`https://api.github.com/repos/${config.github.repo}/git/refs`, {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({ ref: 'refs/heads/__write_probe__', sha: '0'.repeat(40) }),
  });
  if (probe.status === 403) {
    const needed = probe.headers.get('x-accepted-github-permissions') || 'contents=write';
    throw new Error(
      `GITHUB_TOKEN cannot write to ${config.github.repo}. GitHub requires "${needed}". `
      + 'Edit the fine-grained PAT and set Repository permissions -> Contents: Read and write, '
      + 'and Pull requests: Read and write.');
  }
  if (probe.status !== 422 && probe.status !== 201) {
    throw new Error(`GitHub write probe returned an unexpected HTTP ${probe.status}`);
  }
  // A 201 would mean the impossible sha was accepted; clean up defensively.
  if (probe.status === 201) {
    await fetch(`https://api.github.com/repos/${config.github.repo}/git/refs/heads/__write_probe__`,
      { method: 'DELETE', headers: githubHeaders() }).catch(() => {});
  }

  return { repo: repo.full_name, defaultBranch: repo.default_branch };
}
