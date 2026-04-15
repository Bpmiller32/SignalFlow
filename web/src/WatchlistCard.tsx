// WatchlistCard.tsx - Active symbols / watchlist management panel
// Shows all symbols currently in strategies.json.
// Lets you add or remove tickers via PUT /strategies/symbols.

import React, { useState } from "react";
import { StrategiesResponse, StrategyConfig, updateSymbol } from "./api";

interface Props {
  data: StrategiesResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function WatchlistCard({ data, loading, error, onRefresh }: Props) {
  // input field value for adding a new ticker
  const [newSymbol, setNewSymbol] = useState("");
  // feedback message after add/remove
  const [msg, setMsg] = useState<string | null>(null);
  // which ticker is currently being removed (to show loading on just that chip)
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // add a symbol to the first enabled strategy
  async function handleAdd() {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym || !data) return;

    // find the first enabled strategy to add to
    const target = data.strategies.find((s: StrategyConfig) => s.enabled);
    if (!target) {
      setMsg("No enabled strategy found");
      return;
    }

    setAdding(true);
    setMsg(null);
    try {
      const result = await updateSymbol(target.id, sym, "add");
      setMsg(`✓ Added ${sym}`);
      setNewSymbol("");
      // update the local data immediately so the chip appears without a full refresh
      target.symbols = result.symbols;
      onRefresh(); // also re-fetch from server to stay in sync
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  }

  // remove a symbol from its strategy
  async function handleRemove(strategyId: string, symbol: string) {
    setRemoving(symbol);
    setMsg(null);
    try {
      await updateSymbol(strategyId, symbol, "remove");
      setMsg(`✓ Removed ${symbol}`);
      onRefresh(); // re-fetch to update chips
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    } finally {
      setRemoving(null);
    }
  }

  // allow Enter key to submit the add form
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleAdd();
  }

  return (
    <div className="card">
      <div className="card-title">
        📋 Watchlist
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

      {data && !loading && data.strategies.map((strat: StrategyConfig) => (
        <div key={strat.id} style={{ marginBottom: 16 }}>
          {/* strategy label */}
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
            <span className={`badge ${strat.enabled ? "badge-green" : "badge-yellow"}`}>
              {strat.enabled ? "ACTIVE" : "DISABLED"}
            </span>
            {" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{strat.id}</span>
          </div>

          {/* symbol chips */}
          <div className="ticker-grid">
            {strat.symbols.map((sym: string) => (
              <div key={sym} className="ticker-chip">
                {sym}
                {/* remove button on each chip */}
                <button
                  className="btn-icon"
                  onClick={() => handleRemove(strat.id, sym)}
                  disabled={removing === sym}
                  title={`Remove ${sym}`}
                >
                  {removing === sym ? "…" : "×"}
                </button>
              </div>
            ))}
            {strat.symbols.length === 0 && (
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>No symbols</span>
            )}
          </div>
        </div>
      ))}

      {/* add ticker form */}
      {data && !loading && (
        <>
          <hr className="divider" />
          <div className="input-row">
            <input
              className="input"
              placeholder="Add ticker (e.g. TSLA)"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              onKeyDown={handleKeyDown}
              maxLength={10}
            />
            <button
              className="btn btn-primary"
              onClick={handleAdd}
              disabled={adding || !newSymbol.trim()}
            >
              {adding ? <div className="spinner" /> : "+ Add"}
            </button>
          </div>
        </>
      )}

      {/* feedback message */}
      {msg && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: msg.startsWith("Error") ? "var(--red)" : "var(--green)",
          }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
