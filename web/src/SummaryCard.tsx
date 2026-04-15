// SummaryCard.tsx - Today's session summary panel
// Shows today's trades (entry/exit/P&L) and why signals were rejected.

import { SummaryResponse, Trade } from "./api";

interface Props {
  data: SummaryResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function SummaryCard({ data, loading, error, onRefresh }: Props) {
  // format a dollar amount with +/- sign
  function fmt(n: number): string {
    return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  }

  // format holding time (seconds) into a readable string
  function fmtDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m`;
  }

  // format a timestamp string to just HH:MM
  function fmtTime(isoStr: string): string {
    return new Date(isoStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="card">
      <div className="card-title">
        📅 Today's Session
        <button className="btn-refresh" onClick={onRefresh} title="Refresh">↻</button>
      </div>

      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)" }}>
          <div className="spinner" /> Loading...
        </div>
      )}

      {error && !loading && (
        <div className="error-msg">⚠ {error}</div>
      )}

      {data && !loading && (
        <>
          {/* date header */}
          <div style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 12 }}>
            {data.date}
          </div>

          {/* trades table or empty state */}
          {data.trades.length === 0 ? (
            <div className="empty-msg">No trades executed today</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Hold</th>
                  <th>P&L</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((trade: Trade) => (
                  <TradeRow key={trade.id} trade={trade} fmt={fmt} fmtTime={fmtTime} fmtDuration={fmtDuration} />
                ))}
              </tbody>
            </table>
          )}

          {/* rejection summary section */}
          {data.rejections.total > 0 && (
            <>
              <hr className="divider" />
              <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Signal Rejections ({data.rejections.total})
              </div>
              {/* per-stage breakdown */}
              {Object.entries(data.rejections.byStage).map(([stage, count]) => (
                <div key={stage} className="stat-row">
                  <span className="stat-label" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {stage.replace(/_/g, " ")}
                  </span>
                  <span className="stat-value text-dim">{count}</span>
                </div>
              ))}
            </>
          )}

          {data.rejections.total === 0 && data.trades.length === 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              No rejections logged today
            </div>
          )}
        </>
      )}
    </div>
  );
}

// single trade row in the table
function TradeRow({
  trade,
  fmt,
  fmtTime,
  fmtDuration,
}: {
  trade: Trade;
  fmt: (n: number) => string;
  fmtTime: (s: string) => string;
  fmtDuration: (n: number) => string;
}) {
  const isWin = trade.pnl >= 0;

  return (
    <tr>
      <td><span className="sym-tag">{trade.symbol}</span></td>
      <td>
        <span className={`badge ${trade.side === "LONG" ? "badge-green" : "badge-red"}`}>
          {trade.side}
        </span>
      </td>
      <td>${trade.entryPrice.toFixed(2)}<br /><span style={{ fontSize: 10, color: "var(--text-dim)" }}>{fmtTime(trade.entryTime)}</span></td>
      <td>${trade.exitPrice.toFixed(2)}<br /><span style={{ fontSize: 10, color: "var(--text-dim)" }}>{fmtTime(trade.exitTime)}</span></td>
      <td style={{ color: "var(--text-secondary)" }}>{fmtDuration(trade.holdingTime)}</td>
      <td className={isWin ? "text-green" : "text-red"}>
        {fmt(trade.pnl)}
        <br />
        <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
          {trade.exitReason.replace(/_/g, " ")}
        </span>
      </td>
    </tr>
  );
}
