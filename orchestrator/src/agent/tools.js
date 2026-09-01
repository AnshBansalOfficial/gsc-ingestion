import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The agent's tools, scoped to a single workspace directory.
 *
 * This is the codebase-understanding layer. For a repository this small, reading the
 * repository instructions plus targeted file reads and regex search is enough — an
 * embedding index would add infrastructure without improving retrieval. The seam for
 * that upgrade is `search_code`: swapping its implementation for vector or graph
 * retrieval requires no change to the agent loop or the prompt.
 */

const MAX_READ_BYTES = 40_000;
const MAX_SEARCH_HITS = 60;
const MAX_LIST_ENTRIES = 300;
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 600_000);
const SKIP_DIRS = new Set(['.git', 'target', 'node_modules', '.agent-workspace', '.idea']);
const SEARCHABLE = /\.(java|xml|yml|yaml|md|properties|json|html)$/i;

export function createTools(workspaceDir, { onToolEvent } = {}) {
  /** Keeps the agent inside the workspace and away from secrets. */
  function resolveInside(relativePath) {
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('path is required');
    }
    const resolved = path.resolve(workspaceDir, relativePath);
    const root = path.resolve(workspaceDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`path escapes the workspace: ${relativePath}`);
    }
    const rel = path.relative(root, resolved);
    if (rel.split(path.sep).some((part) => part === '.git' || part === '.env')) {
      throw new Error(`path is not accessible to the agent: ${relativePath}`);
    }
    return resolved;
  }

  async function walk(dir, depth = 0, acc = []) {
    if (acc.length >= MAX_LIST_ENTRIES || depth > 8) return acc;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name) || entry.name === '.env') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspaceDir, full);
      if (entry.isDirectory()) {
        acc.push(`${rel}/`);
        await walk(full, depth + 1, acc);
      } else {
        acc.push(rel);
      }
      if (acc.length >= MAX_LIST_ENTRIES) break;
    }
    return acc;
  }

  const implementations = {
    async list_files({ dir = '.' }) {
      const target = resolveInside(dir);
      const entries = await walk(target);
      return entries.length ? entries.join('\n') : '(empty)';
    },

    async read_file({ path: filePath }) {
      const target = resolveInside(filePath);
      const stat = await fs.stat(target);
      if (stat.size > MAX_READ_BYTES) {
        return `File is too large to read in full (${stat.size} bytes). Use search_code to locate the relevant part.`;
      }
      const content = await fs.readFile(target, 'utf8');
      // Line numbers let the agent line up a stack frame with the source.
      return content
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
        .join('\n');
    },

    async search_code({ pattern }) {
      if (!pattern) throw new Error('pattern is required');
      let regex;
      try {
        regex = new RegExp(pattern, 'i');
      } catch (err) {
        throw new Error(`invalid regular expression: ${err.message}`);
      }
      const files = (await walk(workspaceDir)).filter((f) => !f.endsWith('/') && SEARCHABLE.test(f));
      const hits = [];
      for (const rel of files) {
        const content = await fs.readFile(path.join(workspaceDir, rel), 'utf8').catch(() => null);
        if (content === null) continue;
        content.split('\n').forEach((line, i) => {
          if (hits.length < MAX_SEARCH_HITS && regex.test(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
      return hits.length ? hits.join('\n') : `No matches for /${pattern}/`;
    },

    async write_file({ path: filePath, content }) {
      const target = resolveInside(filePath);
      if (typeof content !== 'string') throw new Error('content must be a string');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      const rel = path.relative(workspaceDir, target);
      return `Wrote ${rel} (${content.split('\n').length} lines).`;
    },

    async run_tests() {
      const result = await runMaven(path.join(workspaceDir, 'demo-app'));
      return formatTestResult(result);
    },
  };

  const definitions = [
    {
      name: 'list_files',
      description: 'List files and directories in the repository, recursively. Build output and VCS metadata are excluded.',
      schema: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Directory relative to the repository root. Defaults to the root.' } },
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file from the repository. Output is prefixed with line numbers.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to the repository root.' } },
        required: ['path'],
      },
    },
    {
      name: 'search_code',
      description: 'Case-insensitive regular expression search across source, config and documentation files. Returns path:line: text.',
      schema: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'JavaScript regular expression, e.g. averageLineItemCents' } },
        required: ['pattern'],
      },
    },
    {
      name: 'write_file',
      description: 'Overwrite a file with new content. Always read the file first and pass the COMPLETE updated file content, not a fragment or a diff.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the repository root.' },
          content: { type: 'string', description: 'The complete new content of the file.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'run_tests',
      description: 'Run the full Maven test suite for demo-app and return the result. Takes up to a few minutes.',
      schema: { type: 'object', properties: {} },
    },
  ];

  /** Files the agent has written, so the pipeline can report the real change set. */
  const writtenFiles = new Set();

  /**
   * `silent` is for calls the pipeline makes on the agent's behalf (context prefetch).
   * Reporting those as agent activity would overstate what the model actually did.
   */
  async function execute(name, args, { silent = false } = {}) {
    const impl = implementations[name];
    if (!impl) return { ok: false, content: `Unknown tool "${name}".` };
    if (onToolEvent && !silent) onToolEvent({ name, args });
    try {
      const content = await impl(args || {});
      if (name === 'write_file' && args?.path) writtenFiles.add(args.path);
      return { ok: true, content: String(content) };
    } catch (err) {
      return { ok: false, content: `Tool "${name}" failed: ${err.message}` };
    }
  }

  return { definitions, execute, writtenFiles, runTests: () => runMaven(path.join(workspaceDir, 'demo-app')) };
}

/** Runs `mvn -B test` and returns the raw outcome. */
export function runMaven(cwd, goals = ['-B', 'test']) {
  return new Promise((resolve) => {
    const child = spawn('mvn', goals, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = (chunk) => { output += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ passed: false, timedOut: true, output, summary: `test run exceeded ${TEST_TIMEOUT_MS}ms` });
    }, TEST_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ passed: false, output: String(err), summary: `could not start maven: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const counts = lastMatch(output, /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm);
      const summary = counts
        ? `Tests run: ${counts[1]}, Failures: ${counts[2]}, Errors: ${counts[3]}, Skipped: ${counts[4]}`
        : (code === 0 ? 'build succeeded' : 'build failed before tests ran');
      resolve({ passed: code === 0, exitCode: code, output, summary });
    });
  });
}

function lastMatch(text, regex) {
  let found = null;
  for (const m of text.matchAll(regex)) found = m;
  return found;
}

/** Trims Maven's very verbose output down to what a model can act on. */
export function formatTestResult(result) {
  const header = result.passed ? 'TESTS PASSED' : 'TESTS FAILED';
  const problems = result.output
    .split('\n')
    .filter((l) => /^\[ERROR\]|^\[WARNING\].*deprecat|FAIL|<<< (FAILURE|ERROR)!|^\s+at com\.gsc\.poc/.test(l))
    .slice(0, 60)
    .join('\n');
  return [
    `${header} — ${result.summary}`,
    problems ? `\nRelevant output:\n${problems}` : '',
    result.passed ? '' : '\nFix the cause of the failure and run the tests again.',
  ].join('');
}
