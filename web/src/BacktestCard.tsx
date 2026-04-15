// BacktestCard.tsx - Historical backtest runner panel
// Lets user pick a date range and run POST /backtest.
// Shows formatted results with per-symbol scorecards.

import { useState } from "react";
import { runBacktest, BacktestResponse, BacktestStats } from "./api";

export default function BacktestCard() {
  // form state
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // result state
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // run the backtest when the form is submitted
  async function handleRun() {
    if (!fromDate || !toDate) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await runBacktest(fromDate, toDate);
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // format a dollar value with sign
  function fmt(n: number): string {
    return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  }

  // color class for a number
  function colorClass(n: number): string {
    if (n > 0) return "text-green";
    if (n < 0) return "text-red";
    return "";
  }

  return (
    <div className="card">
      <div className="card-title">📊 Backtest</div>

      {/* date range form */}
      <div className="form-grid">
        <div className="form-group">
          <label>From</label>
          <input
            type="date"
            className="input"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>To</label>
          <input
            type="date"
            className="input"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
      </div>

      <button
        className="btn btn-primary"
        onClick={handleRun}
        disabled={loading || !fromDate || !toDate}
      >
        {loading ? <><div className="spinner" /> Running...</> : "▶ Run Backtest"}
      </button>

      {/* error */}
      {error && <div className="error-msg">⚠ {error}</div>}

      {/* results */}
      {result && !loading && (
        <div className="backtest-results">
          <BacktestSummary stats={result.stats} fmt={fmt} colorClass={colorClass} />
        </div>
      )}
    </div>
  );
}

// top-level summary stats block
function BacktestSummary({
  stats,
  fmt,
  colorClass,
}: {
  stats: BacktestStats;
  fmt: (n: number) => string;
  colorClass: (n: number) => string;
}) {
  // infinity-safe profit factor formatting
  const pfStr = stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2);

  return (
    <>
      {/* overall summary row */}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "16px 0 8px", padding: "12px 16px", background: "rgba(255,255,255,0.02)", borderRadius: 6, border: "1px solid var(--border)" }}>
        <div>
          <div className={`num-medium ${colorClass(stats.totalPnL)}`}>{fmt(stats.totalPnL)}</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Total P&L</div>
        </div>
        <div>
          <div className="num-medium">{stats.totalTrades}</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Trades</div>
        </div>
        <div>
          <div className={`num-medium ${stats.winRate >= 50 ? "text-green" : "text-red"}`}>
            {stats.winRate.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Win Rate</div>
        </div>
        <div>
          <div className="num-medium text-red">-${stats.maxDrawdown.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Max Drawdown</div>
        </div>
        <div>
          <div className="num-medium">{pfStr}</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Profit Factor</div>
        </div>
        <div>
          <div className="num-medium">{stats.averageHoldingMinutes.toFixed(0)}m</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Avg Hold</div>
        </div>
        {stats.peakCapitalRequired > 0 && (
          <div>
            <div className={`num-medium ${colorClass(stats.returnOnCapital)}`}>
              {stats.returnOnCapital >= 0 ? "+" : ""}{stats.returnOnCapital.toFixed(2)}%
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Return on Capital</div>
          </div>
        )}
      </div>

      {/* per-symbol scorecards */}
      {Object.keys(stats.symbolStats).length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "12px 0 4px" }}>
            Ticker Scorecard
          </div>

          {/* sort by P&L, best first */}
          {Object.entries(stats.symbolStats)
            .sort((a, b) => b[1].totalPnL - a[1].totalPnL)
            .map(([sym, ss]) => (
              <SymbolBlock key={sym} symbol={sym} ss={ss} fmt={fmt} colorClass={colorClass} />
            ))}
        </>
      )}
    </>
  );
}

// per-symbol scorecard block
function SymbolBlock({
  symbol,
  ss,
  fmt,
  colorClass,
}: {
  symbol: string;
  ss: BacktestStats["symbolStats"][string];
  fmt: (n: number) => string;
  colorClass: (n: number) => string;
}) {
  const isProfit = ss.totalPnL > 0;
  const pfStr = ss.profitFactor === Infinity ? "∞" : ss.profitFactor.toFixed(2);

  return (
    <div className="bt-symbol-block">
      <div className="bt-symbol-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* green/red dot */}
          <span style={{ color: isProfit ? "var(--green)" : ss.totalPnL < 0 ? "var(--red)" : "var(--text-secondary)" }}>
            {isProfit ? "●" : ss.totalPnL < 0 ? "●" : "○"}
          </span>
          <span className="sym-tag">{symbol}</span>
        </div>
        <span className={`num-small ${colorClass(ss.totalPnL)}`}>{fmt(ss.totalPnL)}</span>
      </div>

      {/* stats grid for this symbol */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
        <StatLine label="Trades" value={`${ss.trades} (${ss.wins}W/${ss.losses}L)`} />
        <StatLine label="Win Rate" value={`${ss.winRate.toFixed(0)}%`} valueClass={ss.winRate >= 50 ? "text-green" : "text-red"} />
        <StatLine label="Avg P&L" value={fmt(ss.avgPnL)} valueClass={colorClass(ss.avgPnL)} />
        <StatLine label="Profit Factor" value={pfStr} />
        <StatLine label="Avg Win" value={`+$${ss.avgWin.toFixed(2)}`} valueClass="text-green" />
        <StatLine label="Avg Loss" value={`$${ss.avgLoss.toFixed(2)}`} valueClass="text-red" />
        <StatLine label="Best" value={`+$${ss.bestTrade.toFixed(2)}`} valueClass="text-green" />
        <StatLine label="Worst" value={`$${ss.worstTrade.toFixed(2)}`} valueClass="text-red" />
        <StatLine label="Avg Hold" value={`${ss.avgHoldingMinutes.toFixed(0)}m`} />
        <StatLine label="Signal Rate" value={`${ss.signalRate.toFixed(1)}% of days`} />
        {(ss.longs > 0 || ss.shorts > 0) && (
          <StatLine
            label="Sides"
            value={`${ss.longs}L (${ss.longWinRate.toFixed(0)}%) / ${ss.shorts}S (${ss.shortWinRate.toFixed(0)}%)`}
          />
        )}
      </div>

      {/* exit reason breakdown */}
      {ss.exitReasons && Object.keys(ss.exitReasons).length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-secondary)" }}>
          Exits: {Object.entries(ss.exitReasons).map(([r, c]) => `${r.replace(/_/g, " ")}: ${c}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

// tiny label/value pair used in the symbol stats grid
function StatLine({ label, value, valueClass = "" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="stat-row" style={{ padding: "2px 0" }}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${valueClass}`}>{value}</span>
    </div>
  );
}
