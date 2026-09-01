import http from 'node:http';
import { config, assertConfig } from './config.js';
import { createLogPoller } from './cloudwatch.js';
import { handleRecord } from './pipeline.js';
import * as status from './status.js';
import { verifySmtp } from './notifier.js';
import { verifyGitHub } from './git.js';

/**
 * Orchestrator entry point.
 *
 * Two responsibilities: tail CloudWatch and run the pipeline, and expose a read-only
 * status API for the demo frontend. The frontend can only read from here — application
 * events are the only thing that starts the agent.
 */

function json(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createStatusServer() {
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS' });
      return res.end();
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only API' });

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      return json(res, 200, { status: 'UP', logGroup: config.aws.logGroup });
    }

    if (url.pathname === '/status') {
      return json(res, 200, {
        pipeline: {
          logGroup: config.aws.logGroup,
          region: config.aws.region,
          model: `${config.llm.provider}/${config.llm.model}`,
          repo: config.github.repo,
          baseBranch: config.github.baseBranch,
          notifyTo: config.smtp.enabled ? config.smtp.to : '(smtp disabled)',
        },
        stages: status.STAGES,
        incidents: status.listIncidents(),
      });
    }

    const match = url.pathname.match(/^\/status\/([\w.-]+)$/);
    if (match) {
      const incident = status.getIncident(match[1]);
      return incident ? json(res, 200, incident) : json(res, 404, { error: 'unknown incident' });
    }

    return json(res, 404, { error: 'not found' });
  });
}

async function main() {
  assertConfig();

  console.log('=== GSC POC orchestrator ===');
  console.log(`  log group : ${config.aws.logGroup} (${config.aws.region})`);
  console.log(`  model     : ${config.llm.provider}/${config.llm.model}`);
  console.log(`  repository: ${config.github.repo} (base ${config.github.baseBranch})`);

  // Fail before a demo rather than during one.
  const gh = await verifyGitHub();
  console.log(`  github    : OK, push access to ${gh.repo}`);
  console.log(`  smtp      : ${await verifySmtp()} -> ${config.smtp.to}`);

  const server = createStatusServer();
  await new Promise((resolve) => server.listen(config.port, resolve));
  console.log(`  status API: http://localhost:${config.port}/status`);

  const poller = createLogPoller({ onRecord: handleRecord });
  poller.start();
  console.log('\nWaiting for application events...\n');

  const shutdown = () => {
    console.log('\nshutting down');
    poller.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('\nstartup failed:', err.message);
  process.exit(1);
});
