import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. See .env.example`);
  return value;
}

const provider = process.env.LLM_PROVIDER || 'groq';

export const config = {
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    logGroup: process.env.CW_LOG_GROUP || '/gsc-poc/demo-app',
  },

  // Polling is the simplest mechanism that genuinely reads from CloudWatch on a local
  // machine. See docs/ARCHITECTURE.md for the production alternative
  // (subscription filter -> EventBridge/SQS -> worker).
  poll: {
    intervalMs: Number(process.env.POLL_INTERVAL_MS || 3000),
    // 'now' ignores history so a demo run only reacts to freshly clicked events.
    from: process.env.POLL_FROM || 'now',
    lookbackMs: Number(process.env.POLL_LOOKBACK_MS || 60_000),
  },

  llm: {
    provider,
    model: process.env.LLM_MODEL || (provider === 'anthropic' ? 'claude-sonnet-5' : 'openai/gpt-oss-120b'),
    apiKey: provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.GROQ_API_KEY,
    maxIterations: Number(process.env.AGENT_MAX_ITERATIONS || 24),
    maxRepairAttempts: Number(process.env.AGENT_MAX_REPAIR_ATTEMPTS || 2),
  },

  github: {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO || 'AnshBansalOfficial/gsc-ingestion',
    baseBranch: process.env.GITHUB_BASE_BRANCH || 'master',
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    to: process.env.NOTIFY_EMAIL_TO || process.env.SMTP_USER,
    // Set SMTP_ENABLED=false to rehearse the pipeline without sending mail.
    enabled: (process.env.SMTP_ENABLED || 'true') !== 'false',
  },

  port: Number(process.env.ORCHESTRATOR_PORT || 8090),
  workspaceDir: path.join(REPO_ROOT, 'orchestrator', '.agent-workspace'),
};

/** Fails fast at startup rather than halfway through an incident. */
export function assertConfig() {
  required('GITHUB_TOKEN');
  if (!config.llm.apiKey) {
    const key = config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GROQ_API_KEY';
    throw new Error(`Missing required environment variable: ${key} (LLM_PROVIDER=${config.llm.provider})`);
  }
  if (config.smtp.enabled) {
    required('SMTP_HOST'); required('SMTP_USER'); required('SMTP_PASSWORD');
  }
}
