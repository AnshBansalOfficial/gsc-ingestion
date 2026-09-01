import StageList from './StageList.jsx';

/**
 * The engineering view, in a panel of its own so the main pane stays a single idea and
 * the page never needs to scroll. Only this panel scrolls, and only when a run is long.
 */
export default function Drawer({ incident, pipeline, earlier, open, onClose }) {
  return (
    <aside className="drawer" aria-hidden={!open} inert={open ? undefined : ''}>
      <div className="drawer-inner">
        <div className="drawer-head">
          <h2>Pipeline detail</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Hide detail">×</button>
        </div>

        {incident?.raw && (
          <>
            <h3>CloudWatch record</h3>
            <div className="log-wrap">
              <pre className="log">{incident.raw}</pre>
            </div>
          </>
        )}

        {incident && (
          <>
            <h3>Stages</h3>
            <StageList stages={incident.stages} />
          </>
        )}

        {earlier.length > 0 && (
          <>
            <h3>Earlier runs</h3>
            <ul className="past">
              {earlier.map((run) => (
                <li key={run.incidentId}>
                  <span className="id">{run.incidentId}</span>
                  <span className="k" data-k={run.kind}>{run.kind}</span>
                  <span className="o">
                    {run.prUrl ? (
                      <a href={run.prUrl} target="_blank" rel="noopener noreferrer">pull request</a>
                    ) : (
                      run.outcome === 'notified' ? 'emailed' : run.outcome
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {pipeline && (
          <p className="rig">
            {[pipeline.model, pipeline.logGroup, pipeline.repo].join('\n')}
          </p>
        )}
      </div>
    </aside>
  );
}
