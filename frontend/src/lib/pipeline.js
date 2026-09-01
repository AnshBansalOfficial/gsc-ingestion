/**
 * Presentation logic for the pipeline, kept out of the components.
 *
 * The orchestrator reports eight engineering stages. Nobody parses eight rows at a
 * glance, so they roll up into the few phases that mean something to someone watching.
 * An alert genuinely has fewer phases than an error, which is how the routing decision
 * becomes visible rather than something the presenter has to explain.
 */

export const PHASES = {
  ERROR: [
    { name: 'Detected', keys: ['LOG_INGESTED'] },
    { name: 'Triaged', keys: ['CLASSIFIED'] },
    { name: 'Agent at work', keys: ['NOTIFIED_START', 'AGENT_ANALYSING', 'FIX_GENERATED', 'TESTS_RUN'] },
    { name: 'Delivered', keys: ['PR_CREATED', 'NOTIFIED_DONE'] },
  ],
  ALERT: [
    { name: 'Detected', keys: ['LOG_INGESTED'] },
    { name: 'Triaged', keys: ['CLASSIFIED'] },
    { name: 'Team notified', keys: ['NOTIFIED_START'] },
  ],
};

export function phasesFor(incident) {
  return PHASES[incident.kind] || PHASES.ERROR;
}

export function phaseState(incident, keys) {
  const own = incident.stages.filter((s) => keys.includes(s.key));
  if (!own.length) return 'pending';
  if (own.some((s) => s.status === 'failed')) return 'failed';
  if (own.every((s) => s.status === 'done' || s.status === 'skipped')) return 'done';
  if (own.some((s) => s.status === 'active' || s.status === 'done')) return 'active';
  return 'pending';
}

/**
 * Stage labels are past-tense records of what completed. As a live headline they read
 * wrong — "Tests run" while the tests are still running — so in-flight stages get their
 * own present-tense wording.
 */
const DOING = {
  LOG_INGESTED: 'Reading the log',
  CLASSIFIED: 'Working out what it is',
  NOTIFIED_START: 'Sending the first email',
  AGENT_ANALYSING: 'Agent reading the codebase',
  FIX_GENERATED: 'Writing the fix',
  TESTS_RUN: 'Running the tests',
  PR_CREATED: 'Opening the pull request',
  NOTIFIED_DONE: 'Sending the summary',
};

export function activeStage(incident) {
  return incident.stages.find((s) => s.status === 'active') || null;
}

export function headline(incident) {
  if (incident.outcome === 'failed') return { text: 'Needs a human', tone: 'error' };
  if (incident.outcome === 'success') return { text: 'Pull request opened', tone: 'done' };
  if (incident.outcome === 'notified') return { text: 'Alert emailed', tone: 'done' };

  const active = activeStage(incident);
  if (!active) return { text: 'Working', tone: 'live' };
  return { text: DOING[active.key] || active.label, tone: 'live' };
}

/** Tool calls are named after the code that runs them. Say what happened instead. */
export function say(detail) {
  if (!detail) return '';
  const base = (p) => String(p).split('/').pop();
  let m;
  if ((m = detail.match(/^read_file\s+(.+)$/))) return `reading ${base(m[1])}`;
  if ((m = detail.match(/^write_file\s+(.+)$/))) return `editing ${base(m[1])}`;
  if ((m = detail.match(/^search_code\s+(.+)$/))) return `searching for ${m[1]}`;
  if (detail.startsWith('list_files')) return 'reading the repository';
  if (detail.startsWith('run_tests')) return 'running the tests';
  if (detail.startsWith('gathering')) return 'gathering context';
  if ((m = detail.match(/^stream\s+(.+)$/))) return m[1];
  if (detail.includes('email sent to')) return `emailed ${detail.split('email sent to').pop().trim()}`;
  if (detail.includes('.java')) return detail.split(', ').map(base).join(', ');
  return detail;
}

export function elapsed(from, to) {
  if (!from || !to) return '';
  return `${((new Date(to) - new Date(from)) / 1000).toFixed(1)}s`;
}

export function shortException(incident) {
  return incident.exception ? incident.exception.class.split('.').pop() : null;
}
