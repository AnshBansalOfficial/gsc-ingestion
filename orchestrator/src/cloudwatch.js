import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { config } from './config.js';

/**
 * Tails a CloudWatch Logs group.
 *
 * Polling with FilterLogEvents is the simplest mechanism that genuinely reads from
 * CloudWatch while the agent runs on a developer machine. The production shape is a
 * subscription filter pushing to EventBridge/SQS with a worker on the other side; the
 * onRecord callback below is the seam where that swap happens, so nothing downstream
 * would change.
 */

/** Events can arrive slightly late, so the checkpoint trails the newest timestamp. */
const LATE_ARRIVAL_GRACE_MS = 10_000;
const MAX_SEEN_IDS = 5000;

export function createLogPoller({ onRecord, onError }) {
  const client = new CloudWatchLogsClient({ region: config.aws.region });
  const seen = new Set();
  let checkpoint = initialCheckpoint();
  let timer = null;
  let running = false;
  let missingGroupWarned = false;

  function initialCheckpoint() {
    switch (config.poll.from) {
      case 'beginning': return 0;
      case 'lookback': return Date.now() - config.poll.lookbackMs;
      default: return Date.now();
    }
  }

  function remember(eventId) {
    seen.add(eventId);
    if (seen.size > MAX_SEEN_IDS) {
      // Oldest-first eviction; Set preserves insertion order.
      const excess = seen.size - MAX_SEEN_IDS;
      let i = 0;
      for (const id of seen) {
        if (i++ >= excess) break;
        seen.delete(id);
      }
    }
  }

  async function pollOnce() {
    let nextToken;
    let newest = checkpoint;
    const batch = [];

    do {
      const response = await client.send(new FilterLogEventsCommand({
        logGroupName: config.aws.logGroup,
        startTime: checkpoint,
        nextToken,
      }));

      for (const event of response.events || []) {
        if (seen.has(event.eventId)) continue;
        remember(event.eventId);
        if (event.timestamp > newest) newest = event.timestamp;

        const record = parseRecord(event.message);
        if (record) batch.push({ record, logStream: event.logStreamName, timestamp: event.timestamp });
      }
      nextToken = response.nextToken;
    } while (nextToken);

    checkpoint = Math.max(checkpoint, newest - LATE_ARRIVAL_GRACE_MS);

    // Chronological delivery, so a burst is processed in the order it happened.
    batch.sort((a, b) => a.timestamp - b.timestamp);
    for (const item of batch) {
      await onRecord(item);
    }
  }

  async function tick() {
    if (!running) return;
    try {
      await pollOnce();
      missingGroupWarned = false;
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') {
        if (!missingGroupWarned) {
          console.warn(`[cloudwatch] log group ${config.aws.logGroup} does not exist yet — waiting for the demo app to create it`);
          missingGroupWarned = true;
        }
      } else if (onError) {
        onError(err);
      } else {
        console.error('[cloudwatch] poll failed:', err?.message || err);
      }
    } finally {
      if (running) timer = setTimeout(tick, config.poll.intervalMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      console.log(`[cloudwatch] tailing ${config.aws.logGroup} in ${config.aws.region} `
        + `(from=${config.poll.from}, every ${config.poll.intervalMs}ms)`);
      tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      client.destroy();
    },
  };
}

/**
 * The demo app emits JSON. Anything unparseable is ignored rather than guessed at —
 * a text-log source would get its own parser here.
 */
function parseRecord(message) {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.level === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export { parseRecord };
