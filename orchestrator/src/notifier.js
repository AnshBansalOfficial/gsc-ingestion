import nodemailer from 'nodemailer';
import { config } from './config.js';

/**
 * SMTP notifications.
 *
 * Three templates, matching the flow in the brief: an operational alert, "the agent has
 * started" (sent immediately so the recipient is not waiting on a silent system), and
 * "the pull request is ready" with the real PR URL.
 *
 * A channel abstraction would be over-engineering here; adding Slack later means adding
 * a sibling module and a `send()` dispatch.
 */

let transporter = null;

function getTransporter() {
  if (!config.smtp.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    });
  }
  return transporter;
}

async function send(subject, lines) {
  const body = lines.filter((l) => l !== null && l !== undefined).join('\n');
  const t = getTransporter();
  if (!t) {
    console.log(`[notifier] SMTP disabled, would have sent: ${subject}`);
    return { skipped: true };
  }
  const info = await t.sendMail({
    from: `"GSC POC Pipeline" <${config.smtp.user}>`,
    to: config.smtp.to,
    subject,
    text: body,
  });
  console.log(`[notifier] sent "${subject}" -> ${config.smtp.to} (${info.messageId})`);
  return { messageId: info.messageId };
}

/** ALERT workflow: one notification, no code change. */
export function sendAlertDetected(incident) {
  return send(`[POC] Alert detected — ${incident.incidentId}`, [
    'An alert has been detected by the system.',
    '',
    `Incident:       ${incident.incidentId}`,
    `Severity:       ${incident.level}`,
    `Message:        ${incident.message}`,
    `Classification: ALERT — ${incident.reason}`,
    `Source:         AWS CloudWatch Logs, group ${config.aws.logGroup}`,
    `Detected at:    ${incident.detectedAt}`,
    '',
    'No code change is required for this event, so the AI engineering agent was not invoked.',
  ]);
}

/** ERROR workflow, email #1 — sent before the agent starts, because the agent is slow. */
export function sendAgentStarted(incident) {
  return send(`[POC] Application error detected — AI agent investigating (${incident.incidentId})`, [
    'An application error has been detected.',
    'The AI engineering agent is investigating the issue and preparing a Pull Request.',
    '',
    `Incident:       ${incident.incidentId}`,
    `Exception:      ${incident.exception?.class}: ${incident.exception?.message}`,
    `Located at:     ${incident.appFrame}`,
    `Classification: ERROR — ${incident.reason}`,
    `Source:         AWS CloudWatch Logs, group ${config.aws.logGroup}`,
    `Detected at:    ${incident.detectedAt}`,
    '',
    `Agent model:    ${config.llm.provider}/${config.llm.model}`,
    `Repository:     ${config.github.repo}`,
    '',
    'You will receive a second email when the Pull Request has been created.',
  ]);
}

/** ERROR workflow, email #2 — success. */
export function sendPullRequestReady(incident) {
  return send(`[POC] AI agent completed the fix — PR ready (${incident.incidentId})`, [
    'The AI engineering agent has completed its investigation.',
    'The fix has been implemented and validated, and a Pull Request has been created.',
    '',
    `Incident:       ${incident.incidentId}`,
    `Exception:      ${incident.exception?.class}: ${incident.exception?.message}`,
    `Root cause:     ${incident.rootCause || 'see pull request description'}`,
    '',
    `Branch:         ${incident.branch}`,
    `Tests:          ${incident.testSummary}`,
    '',
    `Pull Request:   ${incident.prUrl}`,
    '',
    'Please review and merge.',
  ]);
}

/** ERROR workflow, email #2 — failure. No PR is opened when validation fails. */
export function sendAgentFailed(incident, error) {
  return send(`[POC] AI agent could not produce a validated fix (${incident.incidentId})`, [
    'The AI engineering agent investigated the error but did not produce a change that',
    'passed the test suite, so no Pull Request was created.',
    '',
    `Incident:       ${incident.incidentId}`,
    `Exception:      ${incident.exception?.class}: ${incident.exception?.message}`,
    `Located at:     ${incident.appFrame}`,
    `Failure:        ${error}`,
    incident.testSummary ? `Tests:          ${incident.testSummary}` : null,
    '',
    'Human review required.',
  ]);
}

/** Startup check so a bad SMTP password surfaces before a demo, not during one. */
export async function verifySmtp() {
  const t = getTransporter();
  if (!t) return 'disabled';
  await t.verify();
  return 'ok';
}
