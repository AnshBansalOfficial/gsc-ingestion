import PhaseTrack from './PhaseTrack.jsx';
import { activeStage, elapsed, headline, say, shortException } from '../lib/pipeline.js';

/** Where the current run is, in the fewest words that are still true. */
export default function StatusBlock({ incident, detailOpen, onToggleDetail }) {
  const { text, tone } = headline(incident);
  const active = activeStage(incident);

  const meta = [
    incident.incidentId,
    shortException(incident),
    incident.finishedAt
      ? `took ${elapsed(incident.detectedAt, incident.finishedAt)}`
      : say(active?.detail),
  ].filter(Boolean);

  return (
    <div className="status">
      <PhaseTrack incident={incident} />

      <p className="now" data-tone={tone}>{text}</p>
      <p className="meta">{meta.join('  ·  ')}</p>

      <div className="status-actions">
        {incident.prUrl && (
          <a className="pr-link" href={incident.prUrl} target="_blank" rel="noopener noreferrer">
            Open the pull request
          </a>
        )}
        <button
          type="button"
          className="detail-toggle"
          aria-expanded={detailOpen}
          onClick={onToggleDetail}
        >
          {detailOpen ? 'Hide detail' : 'Show detail'}
        </button>
      </div>
    </div>
  );
}
