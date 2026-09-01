/**
 * Identity and the two ways in. The explainer earns its space only before the first run —
 * once something is happening, the status is what people are reading, and dropping the
 * lede is what keeps the whole page inside one viewport.
 */
export default function Hero({ onTrigger, busy, showLede }) {
  return (
    <div className="hero">
      <p className="eyebrow">AI-assisted Java engineering</p>
      <h1>From error to pull request.</h1>

      {showLede && (
        <p className="lede">
          A Java service writes its logs to CloudWatch. When one of them is a real defect,
          an AI agent reads the codebase, fixes it, runs the tests, and opens a pull request.
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onTrigger('/api/error')}>
          Trigger an error
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => onTrigger('/api/alert')}>
          Send an alert
        </button>
      </div>
      <p className="hint">An alert only emails a human. An error starts the agent.</p>
    </div>
  );
}
