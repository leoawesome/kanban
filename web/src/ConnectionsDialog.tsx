import { useState } from "react";
import { api, safeHref, type McpAddInput, type McpServer, type McpState, type McpTransport } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { timeAgo } from "./time";

const STATUS_LABEL: Record<McpServer["status"], [string, string]> = {
  connected: ["Connected", "ok"],
  needs_auth: ["Needs auth", "blocked"],
  failed: ["Failed", "failed"],
  pending: ["Pending approval", "stopped"],
  unknown: ["Unknown", "stopped"],
};
const SCOPE_LABEL: Record<McpServer["scope"], string> = {
  user: "user", local: "local", project: "project", "claude.ai": "claude.ai", other: "other",
};

export function canLogin(s: McpServer): boolean {
  return s.scope === "claude.ai" || s.transport === "http" || s.transport === "sse";
}

/** Splits an argument line like a shell would for quotes, without running anything. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  return out;
}

/** Claude Code MCP servers, like `/mcp`: status, OAuth log in / out, add and remove (user scope). */
export function ConnectionsDialog({ state, onClose }: { state: McpState | null; onClose: () => void }) {
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "remove" | "logout"; server: McpServer } | null>(null);
  const [showIdle, setShowIdle] = useState(false);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const servers = state?.servers ?? [];
  const attention = servers.filter((s) => s.attention);
  const mine = servers.filter((s) => !s.attention && s.scope !== "claude.ai");
  const connectors = servers.filter((s) => !s.attention && s.scope === "claude.ai" && s.status === "connected");
  // claude.ai connectors never set up here; kept out of the way (and out of the badge).
  const idle = servers.filter((s) => !s.attention && s.scope === "claude.ai" && s.status !== "connected");

  const row = (s: McpServer) => {
    const [label, tone] = STATUS_LABEL[s.status];
    const waiting = s.login?.state === "waiting";
    return (
      <div key={s.name} className="mcp-row">
        <div className="mcp-main">
          <div className="mcp-name">
            <span>{s.name}</span>
            <span className={`badge ${tone}`}>{label}</span>
            <span className="badge stopped">{SCOPE_LABEL[s.scope]}</span>
            {s.transport && s.scope !== "claude.ai" && <span className="badge stopped">{s.transport}</span>}
          </div>
          {s.target && <div className="mcp-target" title={s.target}>{s.target}</div>}
          {s.message && s.status !== "needs_auth" && <div className="mcp-msg">{s.message}</div>}
          {waiting && (
            <div className="mcp-msg info">
              <span className="spinner" /> Waiting for you to finish in the browser…{" "}
              {safeHref(s.login?.url) && <a href={safeHref(s.login?.url)} target="_blank" rel="noreferrer">Open the login page</a>}
            </div>
          )}
          {s.login?.state === "failed" && <div className="mcp-msg">{s.login.error}</div>}
        </div>
        <div className="mcp-actions">
          {canLogin(s) && waiting && (
            <button className="btn small ghost" onClick={() => act(`cancel:${s.name}`, () => api.mcpCancelLogin(s.name))}>Cancel</button>
          )}
          {canLogin(s) && !waiting && s.status !== "connected" && (
            <button className="btn small primary" disabled={busy === `login:${s.name}`}
              onClick={() => act(`login:${s.name}`, () => api.mcpLogin(s.name))}>
              {s.status === "needs_auth" ? "Log in" : "Re-authenticate"}
            </button>
          )}
          {canLogin(s) && !waiting && s.status === "connected" && (
            <>
              <button className="btn small ghost" disabled={busy === `login:${s.name}`}
                onClick={() => act(`login:${s.name}`, () => api.mcpLogin(s.name))}>Re-authenticate</button>
              <button className="btn small ghost" onClick={() => setConfirm({ kind: "logout", server: s })}>Log out</button>
            </>
          )}
          {s.scope === "user" && (
            <button className="btn small ghost danger-text" onClick={() => setConfirm({ kind: "remove", server: s })}>Remove</button>
          )}
        </div>
      </div>
    );
  };

  const section = (title: string, list: McpServer[]) => list.length > 0 && (
    <div className="mcp-section">
      <div className="inbox-board">{title}</div>
      {list.map(row)}
    </div>
  );

  return (
    <Modal title="Connections" onClose={onClose} wide>
      <div className="form mcp">
        <div className="mcp-toolbar">
          <span className="muted small">
            Claude Code MCP servers, as <code>claude mcp list</code> sees them from your home folder.{" "}
            {state?.checking ? <><span className="spinner" /> Checking…</> : state?.checkedAt ? `Checked ${timeAgo(state.checkedAt)}.` : ""}
          </span>
          <div className="spacer" />
          <button className="btn small" disabled={!!state?.checking} onClick={() => act("refresh", api.mcpRefresh)}>Refresh</button>
          <button className="btn small primary" onClick={() => setAdding((v) => !v)}>{adding ? "Close form" : "Add server"}</button>
        </div>
        {adding && <AddServerForm onAdded={() => setAdding(false)} />}
        {state?.error && <div className="banner error mcp-banner">{state.error}</div>}
        {err && <div className="form-error">{err}</div>}
        {!state && <div className="muted">Loading…</div>}
        {state && !servers.length && !state.checking && !state.error && (
          <div className="muted">No MCP servers configured. Add one above, or with <code>claude mcp add</code>.</div>
        )}
        {state && !servers.length && state.checking && !state.checkedAt && (
          <div className="muted">Checking every server takes a little while (they're all health-checked)…</div>
        )}
        {section("Needs attention", attention)}
        {section("Servers", mine)}
        {section("claude.ai connectors", connectors)}
        {idle.length > 0 && (
          <div className="mcp-section">
            <button className="link-btn small" onClick={() => setShowIdle((v) => !v)}>
              {showIdle ? "Hide" : "Show"} {idle.length} claude.ai connector{idle.length === 1 ? "" : "s"} not connected
            </button>
            {showIdle && idle.map(row)}
          </div>
        )}
        {state && state.unparsed.length > 0 && (
          <div className="mcp-section">
            <div className="inbox-board">Couldn't read these lines</div>
            <pre className="mcp-raw">{state.unparsed.join("\n")}</pre>
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "remove" ? `Remove ${confirm.server.name}?` : `Log out of ${confirm.server.name}?`}
          confirmLabel={confirm.kind === "remove" ? "Remove" : "Log out"}
          busyLabel={confirm.kind === "remove" ? "Removing…" : "Logging out…"}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === "remove") await api.mcpRemove(confirm.server.name);
            else await api.mcpLogout(confirm.server.name);
            setConfirm(null);
          }}
        >
          {confirm.kind === "remove"
            ? <p>Runs <code>claude mcp remove {confirm.server.name} --scope user</code>. Claude sessions (terminal and board) won't have it anymore.</p>
            : <p>Clears the saved login. Claude can't use this server until you log in again.</p>}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

type Pair = { k: string; v: string };

function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stdio = transport === "stdio";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const filled = pairs.filter((p) => p.k.trim() || p.v);
    const input: McpAddInput = stdio
      ? { name: name.trim(), transport, command: command.trim(), args: splitArgs(args), env: filled.map((p) => ({ key: p.k.trim(), value: p.v })) }
      : { name: name.trim(), transport, url: url.trim(), headers: filled.map((p) => ({ name: p.k.trim(), value: p.v })) };
    setBusy(true);
    setErr(null);
    try {
      await api.mcpAdd(input);
      onAdded();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const setPair = (i: number, patch: Partial<Pair>) => setPairs((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <form className="mcp-add" onSubmit={submit}>
      <div className="row two">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" spellCheck={false} autoFocus />
        </label>
        <div className="field">
          <div className="field-label">Transport</div>
          <div className="segmented" role="radiogroup" aria-label="Transport">
            {(["stdio", "http", "sse"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={transport === t} className={transport === t ? "on" : ""}
                onClick={() => { setTransport(t); setPairs([]); }}>
                {t === "stdio" ? "Command (stdio)" : t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
      {stdio ? (
        <div className="row two">
          <label>
            Command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} />
          </label>
          <label>
            Arguments
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder='-y @modelcontextprotocol/server-github' spellCheck={false} />
          </label>
        </div>
      ) : (
        <label>
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
        </label>
      )}
      <div className="field">
        <div className="field-row">
          <span className="field-label">{stdio ? "Environment variables" : "Headers"}</span>
          <button type="button" className="link-btn small" onClick={() => setPairs((ps) => [...ps, { k: "", v: "" }])}>
            + Add {stdio ? "variable" : "header"}
          </button>
        </div>
        {pairs.map((p, i) => (
          <div key={i} className="mcp-pair">
            <input value={p.k} onChange={(e) => setPair(i, { k: e.target.value })} placeholder={stdio ? "API_KEY" : "Authorization"}
              aria-label={stdio ? "Variable name" : "Header name"} spellCheck={false} />
            <input type="password" value={p.v} onChange={(e) => setPair(i, { v: e.target.value })} placeholder="value"
              aria-label="Value" autoComplete="off" />
            <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <span className="muted small">
          Added with <code>--scope user</code>, so every Claude session can use it.{!stdio && " If it uses OAuth, click Log in once it shows up."}
        </span>
      </div>
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || !name.trim() || (stdio ? !command.trim() : !url.trim())}>
          {busy ? "Adding…" : "Add server"}
        </button>
      </div>
    </form>
  );
}
