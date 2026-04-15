// App.tsx - Root component and layout
// Fetches all data on mount and passes it down to the 5 dashboard cards.
// Auto-refreshes status every 30 seconds so open positions stay current.

import { useState, useEffect, useCallback } from "react";
import {
  fetchStatus,
  fetchBalance,
  fetchSummary,
  fetchStrategies,
  StatusResponse,
  BalanceResponse,
  SummaryResponse,
  StrategiesResponse,
} from "./api";
import StatusCard from "./StatusCard";
import BalanceCard from "./BalanceCard";
import WatchlistCard from "./WatchlistCard";
import BacktestCard from "./BacktestCard";
import SummaryCard from "./SummaryCard";

// how often (ms) to auto-refresh the status card
const STATUS_POLL_MS = 30000;

export default function App() {
  // each panel manages its own loading/error, but we hold the data here
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [strategies, setStrategies] = useState<StrategiesResponse | null>(null);

  // error strings per panel (null = no error)
  const [statusError, setStatusError] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);

  // loading flags per panel
  const [statusLoading, setStatusLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [strategiesLoading, setStrategiesLoading] = useState(true);

  // fetch status from the backend
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const data = await fetchStatus();
      setStatus(data);
    } catch (err) {
      setStatusError((err as Error).message);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // fetch balance/P&L from the backend
  const loadBalance = useCallback(async () => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const data = await fetchBalance();
      setBalance(data);
    } catch (err) {
      setBalanceError((err as Error).message);
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  // fetch today's summary from the backend
  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await fetchSummary();
      setSummary(data);
    } catch (err) {
      setSummaryError((err as Error).message);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  // fetch strategy config (symbols list) from the backend
  const loadStrategies = useCallback(async () => {
    setStrategiesLoading(true);
    setStrategiesError(null);
    try {
      const data = await fetchStrategies();
      setStrategies(data);
    } catch (err) {
      setStrategiesError((err as Error).message);
    } finally {
      setStrategiesLoading(false);
    }
  }, []);

  // load all data on mount
  useEffect(() => {
    loadStatus();
    loadBalance();
    loadSummary();
    loadStrategies();
  }, [loadStatus, loadBalance, loadSummary, loadStrategies]);

  // auto-refresh status every 30s so positions/equity stay live
  useEffect(() => {
    const interval = setInterval(loadStatus, STATUS_POLL_MS);
    return () => clearInterval(interval); // cleanup on unmount
  }, [loadStatus]);

  // whether the bot appears to be online (status loaded without error)
  const isOnline = status !== null && statusError === null;

  return (
    <div className="app">
      {/* ---- HEADER ---- */}
      <header className="header">
        <div className="header-left">
          {/* pulsing dot reflects whether we can reach the backend */}
          <div className={`pulse-dot ${isOnline ? "" : "offline"}`} />
          <div>
            <div className="header-title">SIGNALFLOW</div>
            <div className="header-subtitle">
              Automated Opening Range Breakout — Fair Value Gap Confirmation
            </div>
          </div>
        </div>
        {/* show mode badge in header if available */}
        {status && (
          <span className={`badge badge-${status.mode.toLowerCase()}`}>
            {status.mode}
          </span>
        )}
      </header>

      {/* ---- DASHBOARD GRID ---- */}
      {/* Row 1: Status | Balance | Summary */}
      {/* Row 2: Watchlist | Backtest (full width) */}
      <div className="grid">
        <StatusCard
          data={status}
          loading={statusLoading}
          error={statusError}
          onRefresh={loadStatus}
        />

        <BalanceCard
          data={balance}
          loading={balanceLoading}
          error={balanceError}
          onRefresh={loadBalance}
        />

        <SummaryCard
          data={summary}
          loading={summaryLoading}
          error={summaryError}
          onRefresh={loadSummary}
        />

        <WatchlistCard
          data={strategies}
          loading={strategiesLoading}
          error={strategiesError}
          onRefresh={loadStrategies}
        />

        {/* backtest spans all 3 columns */}
        <div className="grid-full">
          <BacktestCard />
        </div>
      </div>
    </div>
  );
}
