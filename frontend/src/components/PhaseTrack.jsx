import { phasesFor, phaseState } from '../lib/pipeline.js';

/** The whole run in one glance: a few phases, coloured by state. */
export default function PhaseTrack({ incident }) {
  return (
    <ol className="track">
      {phasesFor(incident).map((phase) => (
        <li key={phase.name} className="phase" data-s={phaseState(incident, phase.keys)}>
          <span className="phase-name">{phase.name}</span>
        </li>
      ))}
    </ol>
  );
}
