// BalanceCard.tsx - P&L and performance statistics panel
// Shows all-time totals, win rate, best/worst trades, and a per-symbol breakdown table.

import { BalanceResponse, TradingStats } from "./api";

interface Props {
  data: BalanceResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function BalanceCard({ data, loading, error, onRefresh }: Props) {
  // format a dollar amount with a +/- sign and 2 decimal places
  function fmt(n: number): string {
    return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  }

  // color class for a number (green if positive, red if negative)
  function colorClass(n: number): string {
    if (n > 0) return "text-green";
    if (n < 0) return "text-red";
    return "";
  }

  return (
    <div className="card">
      <div className="card-title">
        💰 P&amp;L &amp; Balance
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
          {/* large total P&L number at top */}
          <div className={`num-large ${colorClass(data.allTimeStats.totalPnL)}`}>
            {fmt(data.allTimeStats.totalPnL)}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2, marginBottom: 12 }}>
            All-time P&L
          </div>

          {/* account equity if available */}
          {data.equity !== null && (
            <div className="stat-row">
              <span className="stat-label">Account Equity</span>
              <span className="stat-value">${data.equity.toFixed(2)}</span>
            </div>
          )}

          <AllTimeStatsBlock stats={data.allTimeStats} fmt={fmt} colorClass={colorClass} />

          {/* per-symbol breakdown table */}
          {Object.keys(data.symbolStats).length > 0 && (
            <>
              <hr className="divider" />
              <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                Per Symbol
              </div>
              <SymbolStatsTable symbolStats={data.symbolStats} fmt={fmt} colorClass={colorClass} />
            </>
          )}

          {/* last updated timestamp */}
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12 }}>
            Updated: {new Date(data.lastUpdated).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}

// all-time stats block with key performance numbers
function AllTimeStatsBlock({
  stats,
  fmt,
  colorClass,
}: {
  stats: TradingStats;
  fmt: (n: number) => string;
  colorClass: (n: number) => string;
}) {
  const winRate = stats.totalTrades > 0
    ? ((stats.wins / stats.totalTrades) * 100).toFixed(1)
    : "0.0";

  return (
    <>
      <hr className="divider" />
      <div className="stat-row">
        <span className="stat-label">Total Trades</span>
        <span className="stat-value">{stats.totalTrades}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Wins / Losses</span>
        <span className="stat-value">
          <span className="text-green">{stats.wins}W</span>
          {" / "}
          <span className="text-red">{stats.losses}L</span>
        </span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Win Rate</span>
        <span className={`stat-value ${parseFloat(winRate) >= 50 ? "text-green" : "text-red"}`}>
          {winRate}%
        </span>
      </div>

      {stats.totalTrades > 0 && (
        <>
          <div className="stat-row">
            <span className="stat-label">Best Trade</span>
            <span className={`stat-value ${colorClass(stats.bestTrade)}`}>{fmt(stats.bestTrade)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Worst Trade</span>
            <span className={`stat-value ${colorClass(stats.worstTrade)}`}>{fmt(stats.worstTrade)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Avg Win</span>
            <span className="stat-value text-green">+${stats.averageWin.toFixed(2)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Avg Loss</span>
            <span className="stat-value text-red">${stats.averageLoss.toFixed(2)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Current Streak</span>
            <span className={`stat-value ${stats.currentStreak.type === "WIN" ? "text-green" : "text-red"}`}>
              {stats.currentStreak.count} {stats.currentStreak.type.toLowerCase()}
              {stats.currentStreak.count !== 1 ? "s" : ""}
            </span>
          </div>
        </>
      )}
    </>
  );
}

// per-symbol table showing trades, P&L, and win rate
function SymbolStatsTable({
  symbolStats,
  fmt,
  colorClass,
}: {
  symbolStats: Record<string, TradingStats>;
  fmt: (n: number) => string;
  colorClass: (n: number) => string;
}) {
  // sort by total P&L descending so best performers show first
  const sorted = Object.entries(symbolStats).sort((a, b) => b[1].totalPnL - a[1].totalPnL);

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Trades</th>
          <th>Win%</th>
          <th>P&L</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(([sym, stats]) => {
          const wr = stats.totalTrades > 0
            ? ((stats.wins / stats.totalTrades) * 100).toFixed(0)
            : "0";
          return (
            <tr key={sym}>
              <td><span className="sym-tag">{sym}</span></td>
              <td>{stats.totalTrades}</td>
              <td className={parseFloat(wr) >= 50 ? "text-green" : "text-red"}>{wr}%</td>
              <td className={colorClass(stats.totalPnL)}>{fmt(stats.totalPnL)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
