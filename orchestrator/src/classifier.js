/**
 * Rule based log classification.
 *
 * Deliberately not an LLM: classification sits on the hot path for every log line, must
 * be deterministic, and must be explainable during a review. The rules are data, so a
 * future version can load them from config, add ML scoring, or consult a service without
 * changing any caller.
 */

const APP_PACKAGE = process.env.APP_PACKAGE || 'com.gsc.poc';

/** Frames in these packages are application code but not business logic. */
const INFRASTRUCTURE_PACKAGES = [`${APP_PACKAGE}.logging`];

export const Kind = {
  /** A code defect located in application source — starts the AI engineering workflow. */
  ERROR: 'ERROR',
  /** Something a human should know about, but not a code defect — notify only. */
  ALERT: 'ALERT',
  /** Routine operational logging — no action. */
  IGNORE: 'IGNORE',
};

/**
 * @param {object} record parsed JSON log event emitted by the demo app
 * @returns {{kind: string, reason: string, fingerprint: string|null, appFrame: string|null}}
 */
export function classify(record) {
  const level = String(record?.level || '').toUpperCase();

  if (level === 'ERROR' || level === 'FATAL') {
    const appFrame = findApplicationFrame(record?.exception?.stackTrace);
    if (record?.exception && appFrame) {
      return {
        kind: Kind.ERROR,
        reason: `${level} with ${record.exception.class} thrown in application code (${appFrame.location})`,
        fingerprint: `${record.exception.class}@${appFrame.location}`,
        appFrame: appFrame.location,
      };
    }
    // An error with no application frame is usually infrastructure (network, AWS, driver).
    // A human should look; an autonomous code change would be guesswork.
    return {
      kind: Kind.ALERT,
      reason: `${level} without an application stack frame — treated as operational, not a code defect`,
      fingerprint: null,
      appFrame: null,
    };
  }

  if (level === 'WARN') {
    return { kind: Kind.ALERT, reason: 'WARN level operational alert', fingerprint: null, appFrame: null };
  }

  return { kind: Kind.IGNORE, reason: `level ${level || 'UNKNOWN'} requires no action`, fingerprint: null, appFrame: null };
}

/**
 * First stack frame that belongs to application business logic.
 * This is what tells the agent which file to open, so infrastructure frames are skipped.
 */
function findApplicationFrame(stackTrace) {
  if (!stackTrace) return null;
  for (const line of stackTrace.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ') || !trimmed.includes(APP_PACKAGE)) continue;
    if (INFRASTRUCTURE_PACKAGES.some((pkg) => trimmed.includes(pkg))) continue;

    const match = trimmed.match(/at ([\w.$]+)\(([\w.]+):(\d+)\)/);
    if (!match) continue;
    return {
      method: match[1],
      file: match[2],
      line: Number(match[3]),
      location: `${match[2]}:${match[3]}`,
    };
  }
  return null;
}

export { findApplicationFrame };
