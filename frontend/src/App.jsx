import { useEffect, useState } from 'react';
import Hero from './components/Hero.jsx';
import StatusBlock from './components/StatusBlock.jsx';
import Drawer from './components/Drawer.jsx';
import { usePipelineStatus } from './lib/usePipelineStatus.js';

export default function App() {
  const { status, error } = usePipelineStatus();
  const [busy, setBusy] = useState(false);
  const [triggerError, setTriggerError] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [userClosed, setUserClosed] = useState(false);

  const incidents = status?.incidents ?? [];
  const [current, ...earlier] = incidents;

  // Open the detail panel the first time a run appears, but never fight someone who
  // deliberately closed it.
  useEffect(() => {
    if (current && !userClosed) setDetailOpen(true);
  }, [current, userClosed]);

  /**
   * Triggers only ask the Java service to do its normal job, which is to log. Everything
   * downstream is driven by what reaches CloudWatch.
   */
  async function trigger(path) {
    setBusy(true);
    try {
      await fetch(path, { method: 'POST' });
      setTriggerError(null);
    } catch {
      setTriggerError('The Java service is not responding. Start it with scripts/start.sh');
    } finally {
      setTimeout(() => setBusy(false), 1500);
    }
  }

  function toggleDetail() {
    setDetailOpen((open) => {
      if (open) setUserClosed(true);
      return !open;
    });
  }

  const problem = triggerError || error;

  return (
    <div className="app" data-detail={detailOpen && Boolean(current)}>
      <main className="stage">
        <div className="stage-inner">
          <Hero onTrigger={trigger} busy={busy} showLede={!current} />

          {problem && <p className="alarm">{problem}</p>}

          {current && (
            <StatusBlock
              incident={current}
              detailOpen={detailOpen}
              onToggleDetail={toggleDetail}
            />
          )}
        </div>
      </main>

      <Drawer
        incident={current}
        pipeline={status?.pipeline}
        earlier={earlier}
        open={detailOpen && Boolean(current)}
        onClose={toggleDetail}
      />
    </div>
  );
}
