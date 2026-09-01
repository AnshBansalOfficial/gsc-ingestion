import { config } from './config.js';
import { classify, Kind } from './classifier.js';
import * as status from './status.js';
import * as notifier from './notifier.js';
import * as vcs from './git.js';
import { runAgent } from './agent/index.js';
import { runMaven, formatTestResult } from './agent/tools.js';
import path from 'node:path';

/**
 * Drives one log record through the pipeline.
 *
 * Classification decides which of the two workflows runs. Only a classified ERROR with a
 * located application frame reaches the AI agent; everything else is a notification.
 */

const seenIncidents = new Set();

/** Agent runs are serialised: two clicks must not race on the same repository. */
let queue = Promise.resolve();

export async function handleRecord({ record, logStream }) {
  const verdict = classify(record);
  if (verdict.kind === Kind.IGNORE) return;

  const incidentId = record.incidentId || `INC-auto-${record.timestamp || Date.now()}`;
  if (seenIncidents.has(incidentId)) return;
  seenIncidents.add(incidentId);

  const incident = status.createIncident({
    incidentId,
    kind: verdict.kind,
    reason: verdict.reason,
    level: record.level,
    message: record.message,
    exception: record.exception,
    appFrame: verdict.appFrame,
    logStream,
  });
  status.updateIncident(incidentId, {
    stackTrace: record.exception?.stackTrace || null,
    logGroup: config.aws.logGroup,
    fingerprint: verdict.fingerprint,
  });

  status.setStage(incidentId, 'LOG_INGESTED', 'done', `stream ${logStream}`);
  status.setStage(incidentId, 'CLASSIFIED', 'done', `${verdict.kind} — ${verdict.reason}`);
  console.log(`[pipeline] ${incidentId} classified ${verdict.kind}: ${verdict.reason}`);

  if (verdict.kind === Kind.ALERT) {
    return runAlertWorkflow(incidentId);
  }

  // Errors run behind a queue; the poller must stay responsive while the agent works.
  queue = queue.then(() => runErrorWorkflow(incidentId)).catch((err) => {
    console.error('[pipeline] unhandled workflow error:', err);
  });
  return queue;
}

async function runAlertWorkflow(incidentId) {
  const incident = status.getIncident(incidentId);
  try {
    await notifier.sendAlertDetected(incident);
    status.setStage(incidentId, 'NOTIFIED_START', 'done', `alert email sent to ${config.smtp.to}`);
    status.finishIncident(incidentId, 'notified');
  } catch (err) {
    status.setStage(incidentId, 'NOTIFIED_START', 'failed', err.message);
    status.finishIncident(incidentId, 'failed');
    console.error(`[pipeline] ${incidentId} alert email failed:`, err.message);
  }
}

async function runErrorWorkflow(incidentId) {
  const incident = status.getIncident(incidentId);
  const branch = `ai-fix/${incidentId.toLowerCase()}`;

  try {
    // Email #1 goes out before any slow work starts.
    await notifier.sendAgentStarted(incident).catch((err) => {
      console.error('[pipeline] start email failed (continuing):', err.message);
    });
    status.setStage(incidentId, 'NOTIFIED_START', 'done', `"agent started" email sent to ${config.smtp.to}`);

    status.setStage(incidentId, 'AGENT_ANALYSING', 'active', 'cloning repository');
    const workspaceDir = await vcs.prepareWorkspace(incidentId);
    await vcs.createBranch(workspaceDir, branch);
    status.updateIncident(incidentId, { branch });

    // Every agent tool call, run_tests included, reports against the analysis stage.
    // TESTS_RUN represents the orchestrator's own authoritative run, so attributing the
    // agent's self-checks to it would light up two stages at once and out of order.
    const onProgress = ({ type, name, target }) => {
      if (type !== 'tool') return;
      const label = target ? `${name} ${target}` : name;
      status.setStage(incidentId, 'AGENT_ANALYSING', 'active', label);
      console.log(`[agent] ${incidentId} ${label}`);
    };

    let result = await runAgent({ incident: status.getIncident(incidentId), workspaceDir, onProgress });
    status.setStage(incidentId, 'AGENT_ANALYSING', 'done',
      `${result.toolLog.length} tool calls, ${result.changedFiles.length} file(s) written`);

    let changes = await vcs.getChanges(workspaceDir);
    if (changes.files.length === 0) {
      throw new Error('the agent did not modify any file');
    }

    // A passing suite is not sufficient evidence of a fix: the existing tests pass with
    // OR without a guard for the empty case, so a change with no new test would sail
    // through. AGENTS.md requires a test for every behaviour change, so require the
    // agent to have touched a test file before this can reach a pull request.
    for (let attempt = 1; !touchesTests(changes.files) && attempt <= config.llm.maxRepairAttempts; attempt++) {
      console.warn(`[pipeline] ${incidentId} no regression test added — asking the agent for one (attempt ${attempt})`);
      status.setStage(incidentId, 'FIX_GENERATED', 'active',
        `source changed but no test added — requesting a regression test (attempt ${attempt})`);

      result = await runAgent({
        incident: {
          ...status.getIncident(incidentId),
          message: `${incident.message}\n\nYour fix changed only ${changes.files.join(', ')}. `
            + 'AGENTS.md requires a regression test for every behaviour change. Add a test to '
            + 'demo-app/src/test/java/com/gsc/poc/service/InvoiceServiceTest.java that fails '
            + 'without your fix and passes with it, then run run_tests.',
        },
        workspaceDir,
        onProgress,
      });
      changes = await vcs.getChanges(workspaceDir);
    }

    const hasRegressionTest = touchesTests(changes.files);
    status.updateIncident(incidentId, { hasRegressionTest });
    status.setStage(incidentId, 'FIX_GENERATED', 'done',
      changes.files.join(', ') + (hasRegressionTest ? '' : ' (no regression test — flagged in the PR)'));

    // The orchestrator validates independently — the agent's own claim is not enough.
    status.setStage(incidentId, 'TESTS_RUN', 'active', 'running mvn test');
    let testResult = await runMaven(path.join(workspaceDir, 'demo-app'));

    for (let attempt = 1; !testResult.passed && attempt <= config.llm.maxRepairAttempts; attempt++) {
      console.warn(`[pipeline] ${incidentId} tests failed (${testResult.summary}) — repair attempt ${attempt}`);
      status.setStage(incidentId, 'TESTS_RUN', 'active',
        `tests failed (${testResult.summary}) — repair attempt ${attempt}`);

      const repairIncident = {
        ...status.getIncident(incidentId),
        message: `${incident.message}\n\nA previous fix attempt failed validation:\n${formatTestResult(testResult)}`,
      };
      result = await runAgent({ incident: repairIncident, workspaceDir, onProgress });
      changes = await vcs.getChanges(workspaceDir);
      testResult = await runMaven(path.join(workspaceDir, 'demo-app'));
    }

    status.updateIncident(incidentId, { testSummary: testResult.summary });

    if (!testResult.passed) {
      status.setStage(incidentId, 'TESTS_RUN', 'failed', testResult.summary);
      status.setStage(incidentId, 'PR_CREATED', 'skipped', 'no pull request opened — validation failed');
      throw new Error(`tests did not pass after ${config.llm.maxRepairAttempts} repair attempt(s): ${testResult.summary}`);
    }
    status.setStage(incidentId, 'TESTS_RUN', 'done', testResult.summary);

    status.setStage(incidentId, 'PR_CREATED', 'active', 'committing and pushing');
    const report = result.report;
    const title = report.title || `Fix ${incident.exception?.class || 'application error'} for incident ${incidentId}`;

    await vcs.commitAll(workspaceDir, commitMessage(incidentId, title, report));
    await vcs.pushBranch(workspaceDir, branch);

    const pr = await vcs.openPullRequest({
      title,
      head: branch,
      body: pullRequestBody({ incident: status.getIncident(incidentId), report, changes, testResult }),
    });

    status.updateIncident(incidentId, { prUrl: pr.url, rootCause: report.rootCause });
    status.setStage(incidentId, 'PR_CREATED', 'done', `#${pr.number} ${pr.url}`);
    console.log(`[pipeline] ${incidentId} pull request ready: ${pr.url}`);

    await notifier.sendPullRequestReady(status.getIncident(incidentId));
    status.setStage(incidentId, 'NOTIFIED_DONE', 'done', `PR email sent to ${config.smtp.to}`);
    status.finishIncident(incidentId, 'success');
  } catch (err) {
    console.error(`[pipeline] ${incidentId} failed:`, err.message);
    const active = status.getIncident(incidentId)?.stages.find((s) => s.status === 'active');
    if (active) status.setStage(incidentId, active.key, 'failed', err.message);
    status.finishIncident(incidentId, 'failed');
    await notifier.sendAgentFailed(status.getIncident(incidentId), err.message).catch(() => {});
    status.setStage(incidentId, 'NOTIFIED_DONE', 'done', 'failure email sent');
  }
}

/** AGENTS.md requires a test alongside any behaviour change. */
function touchesTests(files) {
  return files.some((f) => f.includes('/src/test/'));
}

function commitMessage(incidentId, title, report) {
  return [
    title,
    '',
    `Incident: ${incidentId}`,
    report.rootCause ? `Root cause: ${report.rootCause}` : null,
    '',
    'Generated by the AI engineering agent from a CloudWatch error signal.',
  ].filter((l) => l !== null).join('\n');
}

export function pullRequestBody({ incident, report, changes, testResult }) {
  const section = (heading, value) => (value ? `## ${heading}\n\n${value}\n` : null);
  return [
    '> Opened automatically by the AI engineering agent in response to a production error signal.',
    '',
    '## Incident',
    '',
    `| | |`,
    `|---|---|`,
    `| Incident ID | \`${incident.incidentId}\` |`,
    `| Detected at | ${incident.detectedAt} |`,
    `| Source | AWS CloudWatch Logs — \`${incident.logGroup}\` |`,
    `| Log stream | \`${incident.logStream}\` |`,
    `| Severity | ${incident.level} |`,
    `| Classification | ${incident.kind} — ${incident.reason} |`,
    `| Exception | \`${incident.exception?.class}: ${incident.exception?.message}\` |`,
    `| Failing frame | \`${incident.appFrame}\` |`,
    `| Agent model | \`${config.llm.provider}/${config.llm.model}\` |`,
    '',
    section('Root cause', report.rootCause),
    section('Change', report.change),
    '## Validation\n',
    '```',
    `mvn -B test  ->  ${testResult.passed ? 'PASSED' : 'FAILED'}`,
    testResult.summary,
    '```',
    '',
    incident.hasRegressionTest === false
      ? '> **Reviewer note:** the agent did not add a regression test for this change, so the '
        + 'passing suite does not by itself prove the defect is fixed. Please add one before merging.\n'
      : null,
    report.tests ? `${report.tests}\n` : null,
    '## Files changed\n',
    '```',
    changes.diffStat || changes.files.join('\n'),
    '```',
    '',
    '---',
    '',
    `Log message: \`${incident.message}\``,
    // Only optional sections are dropped. Empty strings in this list are deliberate blank
    // lines: Markdown needs them to separate a heading or table from the text above it.
  ].filter((l) => l !== null && l !== undefined).join('\n');
}

export { seenIncidents };
