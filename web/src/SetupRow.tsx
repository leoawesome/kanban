import type { SetupResult } from "./api";

function secs(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** "Worktree setup · 14.2s": files the board copied into the new worktree and the setup command, output on click. */
export function SetupRow({ setup, old }: { setup: SetupResult; old?: boolean }) {
  const failed = setup.ok === false;
  return (
    <details className={`setup-row${failed ? " failed" : ""}${old ? " inherited" : ""}`}>
      <summary>
        Worktree setup · {secs(setup.durationMs)}
        {failed && <span className="setup-fail"> · failed</span>}
      </summary>
      <div className="setup-lines">
        {setup.copied.length > 0 && <div><span className="setup-ok">✓</span> copied {setup.copied.join(", ")}</div>}
        {setup.missing.length > 0 && <div className="muted">– not found: {setup.missing.join(", ")}</div>}
        {setup.command && (
          <div>
            {failed ? <span className="setup-err">✗</span> : <span className="setup-ok">✓</span>} <code>{setup.command}</code>
            {failed && <span className="muted"> {setup.timedOut ? "(timed out)" : setup.exitCode !== null ? `(exit ${setup.exitCode})` : ""}</span>}
          </div>
        )}
        {setup.output && <pre className="setup-output">{setup.output}</pre>}
        {failed && <div className="muted small">Claude started anyway and was shown this output.</div>}
      </div>
    </details>
  );
}
