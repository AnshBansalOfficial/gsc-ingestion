import { useEffect, useState } from 'react';

/**
 * Polls the orchestrator's read-only status API.
 *
 * The console never asks the orchestrator to do anything — it only reads. Work is
 * started by the Java service emitting a log, which is the whole point of the
 * architecture: an application signal starts the engineering workflow, not a button
 * wired to the agent.
 */
const POLL_MS = 1200;

export function usePipelineStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function resolveOrchestrator() {
      try {
        const config = await (await fetch('/api/config')).json();
        return config.orchestratorUrl || 'http://localhost:8090';
      } catch {
        return 'http://localhost:8090';
      }
    }

    async function run() {
      const base = await resolveOrchestrator();

      const tick = async () => {
        try {
          const data = await (await fetch(`${base}/status`)).json();
          if (cancelled) return;
          setStatus(data);
          setError(null);
        } catch {
          if (!cancelled) setError('The orchestrator is not responding. Start it with scripts/start.sh');
        } finally {
          if (!cancelled) timer = setTimeout(tick, POLL_MS);
        }
      };
      tick();
    }
    run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { status, error };
}
