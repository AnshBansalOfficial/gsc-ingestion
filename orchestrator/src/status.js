/**
 * In-memory incident timeline, read by the demo frontend.
 *
 * Deliberately not persisted: a POC restart should start from a clean slate. Swapping
 * this for Redis/Postgres later means reimplementing this module's four functions.
 */

/** Ordered pipeline stages, shown as a timeline in the UI. */
export const STAGES = [
  { key: 'LOG_INGESTED', label: 'CloudWatch log received' },
  { key: 'CLASSIFIED', label: 'Event classified' },
  { key: 'NOTIFIED_START', label: 'Notification sent' },
  { key: 'AGENT_ANALYSING', label: 'AI agent analysing codebase' },
  { key: 'FIX_GENERATED', label: 'Fix generated' },
  { key: 'TESTS_RUN', label: 'Tests run' },
  { key: 'PR_CREATED', label: 'Pull request created' },
  { key: 'NOTIFIED_DONE', label: 'Completion email sent' },
];

/** Stages that only apply to the ERROR (AI) workflow. */
const ERROR_ONLY_STAGES = new Set([
  'AGENT_ANALYSING', 'FIX_GENERATED', 'TESTS_RUN', 'PR_CREATED', 'NOTIFIED_DONE',
]);

const MAX_INCIDENTS = 50;
const incidents = new Map();

export function createIncident({ incidentId, kind, reason, level, message, exception, appFrame, logStream }) {
  const stages = STAGES
    .filter((s) => kind === 'ERROR' || !ERROR_ONLY_STAGES.has(s.key))
    .map((s) => ({ ...s, status: 'pending', at: null, detail: null }));

  const incident = {
    incidentId,
    kind,
    reason,
    level,
    message,
    exception: exception ? { class: exception.class, message: exception.message } : null,
    appFrame: appFrame || null,
    logStream: logStream || null,
    detectedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: 'in_progress',
    prUrl: null,
    branch: null,
    testSummary: null,
    stages,
  };

  incidents.set(incidentId, incident);
  while (incidents.size > MAX_INCIDENTS) {
    incidents.delete(incidents.keys().next().value);
  }
  return incident;
}

/**
 * Mark a stage. `status` is one of pending | active | done | failed | skipped.
 */
export function setStage(incidentId, key, status, detail = null) {
  const incident = incidents.get(incidentId);
  if (!incident) return;
  const stage = incident.stages.find((s) => s.key === key);
  if (!stage) return;
  stage.status = status;
  stage.at = new Date().toISOString();
  if (detail !== null) stage.detail = detail;
}

export function updateIncident(incidentId, patch) {
  const incident = incidents.get(incidentId);
  if (!incident) return;
  Object.assign(incident, patch);
}

export function finishIncident(incidentId, outcome) {
  updateIncident(incidentId, { outcome, finishedAt: new Date().toISOString() });
}

export function getIncident(incidentId) {
  return incidents.get(incidentId) || null;
}

/** Newest first, for the frontend list. */
export function listIncidents() {
  return [...incidents.values()].reverse();
}
