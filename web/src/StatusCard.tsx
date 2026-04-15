// StatusCard.tsx - Bot status panel
// Shows mode (PAPER/LIVE), runner state, account equity, and any open positions.
// Also has a Restart button that calls POST /restart.

import { useState } from "react";
import { StatusResponse, Position, restartBot } from "./api";

interface Props {
  data: StatusResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function StatusCard({ data, loading, error, onRefresh }: Props) {
  // local state just for the restart button
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);

  // call the restart endpoint, then refresh status
  async function handleRestart() {
    if (!window.confirm("Restart the strategy runner?")) return;
    setRestarting(true);
    setRestartMsg(null);
    try {
      const result = await restartBot();
      setRestartMsg(result.message);
      // wait a beat then refresh so status reflects the new runner state
      setTimeout(onRefresh, 1500);
    } catch (err) {
      setRestartMsg(`Error: ${(err as Error).message}`);
    } finally {
      setRestarting(false);
    }
  }

  // pick a dot color based on runner status text
  function statusDotClass(status: string): string {
    const s = status.toLowerCase();
    if (s.includes("monitor") || s.includes("waiting") || s.includes("capturing")) return "green";
    if (s.includes("position") || s.includes("open")) return "yellow";
    if (s.includes("stopped") || s.includes("not")) return "red";
    return "gray";
  }

  return (
    <div className="card">
      <div className="card-title">
        🤖 Bot Status
        {/* refresh icon in top-right corner */}
        <button className="btn-refresh" onClick={onRefresh} title="Refresh">
          ↻
        </button>
      </div>

      {/* loading state */}
      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)" }}>
          <div className="spinner" /> Loading...
        </div>
      )}

      {/* error state */}
      {error && !loading && (
        <div className="error-msg">
          ⚠ Cannot reach backend: {error}
        </div>
      )}

      {/* data state */}
      {data && !loading && (
        <>
          {/* mode badge + runner status */}
          <div className="stat-row">
            <span className="stat-label">Mode</span>
            <span className={`badge badge-${data.mode.toLowerCase()}`}>{data.mode}</span>
          </div>

          <div className="stat-row">
            <span className="stat-label">Runner</span>
            <span className="stat-value">
              <span className={`status-dot ${statusDotClass(data.status)}`} />
              {data.status}
            </span>
          </div>

          <hr className="divider" />

          {/* account figures */}
          {data.equity !== null && (
            <div className="stat-row">
              <span className="stat-label">Equity</span>
              <span className="stat-value">${data.equity.toFixed(2)}</span>
            </div>
          )}
          {data.cash !== null && (
            <div className="stat-row">
              <span className="stat-label">Cash</span>
              <span className="stat-value">${data.cash.toFixed(2)}</span>
            </div>
          )}

          {/* open positions (if any) */}
          {data.positions.length > 0 && (
            <>
              <hr className="divider" />
              <div className="stat-label" style={{ marginBottom: 4 }}>Open Positions</div>
              {data.positions.map((pos: Position) => (
                <PositionRow key={pos.symbol} pos={pos} />
              ))}
            </>
          )}

          {data.positions.length === 0 && (
            <div className="stat-row">
              <span className="stat-label">Positions</span>
              <span className="stat-value text-dim">None</span>
            </div>
          )}

          <hr className="divider" />

          {/* restart button */}
          <button
            className="btn btn-danger"
            onClick={handleRestart}
            disabled={restarting}
            style={{ width: "100%" }}
          >
            {restarting ? <><div className="spinner" /> Restarting...</> : "⟳ Restart Runner"}
          </button>

          {/* restart feedback message */}
          {restartMsg && (
            <div className={restartMsg.startsWith("Error") ? "error-msg" : ""}
              style={restartMsg.startsWith("Error") ? {} : { marginTop: 8, fontSize: 12, color: "var(--green)" }}>
              {restartMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// small sub-component for a single open position row
function PositionRow({ pos }: { pos: Position }) {
  return (
    <div className="position-row">
      <div>
        <span className="sym-tag">{pos.symbol}</span>
        {" "}
        <span className={`badge ${pos.side === "LONG" ? "badge-green" : "badge-red"}`}>
          {pos.side}
        </span>
      </div>
      <div className="num-small">
        {pos.quantity} sh @ ${pos.entryPrice.toFixed(2)}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        SL: ${pos.stopLoss.toFixed(2)} · TP: ${pos.takeProfit.toFixed(2)}
      </div>
    </div>
  );
}
