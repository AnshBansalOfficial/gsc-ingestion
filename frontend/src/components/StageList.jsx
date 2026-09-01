import { say } from '../lib/pipeline.js';

const MARK = { done: '✓', active: '▸', failed: '✗', skipped: '–' };

/**
 * The engineering stages behind the phases.
 *
 * Label and detail stack rather than sharing a line: the drawer is narrow, and side by
 * side either wraps the label mid-phrase or truncates the detail to nothing.
 */
export default function StageList({ stages }) {
  return (
    <ol className="steps">
      {stages.map((stage) => {
        const detail = say(stage.detail);
        return (
          <li key={stage.key} data-s={stage.status}>
            <span className="s" aria-hidden="true">{MARK[stage.status] || '·'}</span>
            <span className="body">
              <span className="l">{stage.label}</span>
              {detail && <span className="r">{detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
