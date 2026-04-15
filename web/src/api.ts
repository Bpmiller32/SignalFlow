// api.ts - All HTTP calls to the SignalFlow backend API in one place.
// Import these functions in components rather than making raw fetch calls.
// VITE_API_URL: the Pi's address + port (e.g. http://192.168.1.100:3001)
// VITE_API_KEY: shared secret for mutation endpoints (restart, symbols)

// ---- TYPES (matching what apiServer.ts returns) ----

export interface Position {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
}

export interface StatusResponse {
  mode: "PAPER" | "LIVE";
  status: string;
  equity: number | null;
  cash: number | null;
  positions: Position[];
}

export interface TradingStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  bestTrade: number;
  worstTrade: number;
  averageWin: number;
  averageLoss: number;
  currentStreak: { type: "WIN" | "LOSS"; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface BalanceResponse {
  equity: number | null;
  cash: number | null;
  allTimeStats: TradingStats;
  symbolStats: Record<string, TradingStats>;
  lastUpdated: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  quantity: number;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  pnlPercent: number;
  holdingTime: number;
}

export interface SummaryResponse {
  date: string;
  trades: Trade[];
  rejections: {
    total: number;
    byStage: Record<string, number>;
    bySymbol: Record<string, number>;
  };
}

export interface StrategyConfig {
  id: string;
  type: string;
  enabled: boolean;
  symbols: string[];
  maxTradesPerDay: number;
}

export interface StrategiesResponse {
  strategies: StrategyConfig[];
}

// backtest stats returned from the server (subset of what Discord formats)
export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  maxDrawdown: number;
  profitFactor: number;
  averageHoldingMinutes: number;
  peakCapitalRequired: number;
  returnOnCapital: number;
  totalCapitalDeployed: number;
  symbolStats: Record<string, {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnL: number;
    avgPnL: number;
    bestTrade: number;
    worstTrade: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    longs: number;
    shorts: number;
    longWinRate: number;
    shortWinRate: number;
    avgHoldingMinutes: number;
    signalRate: number;
    exitReasons: Record<string, number>;
  }>;
}

export interface BacktestResponse {
  stats: BacktestStats;
}

// ---- HELPERS ----

// the backend URL - set VITE_API_URL in web/.env (e.g. http://192.168.1.100:3001)
const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:3001";

// the shared secret for mutation endpoints - set VITE_API_KEY in web/.env
const API_KEY = (import.meta.env.VITE_API_KEY as string) || "";

// base fetch wrapper with JSON parsing and error handling
async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_URL}${path}`;

  // add API key header to all requests (ignored by server if no key configured)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    ...(options.headers as Record<string, string> || {}),
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((error as { error: string }).error || response.statusText);
  }

  return response.json() as Promise<T>;
}

// ---- API FUNCTIONS ----

// GET /status - bot mode, runner status, open positions
export function fetchStatus(): Promise<StatusResponse> {
  return apiFetch<StatusResponse>("/status");
}

// GET /balance - all-time P&L and per-symbol stats
export function fetchBalance(): Promise<BalanceResponse> {
  return apiFetch<BalanceResponse>("/balance");
}

// GET /summary - today's trade history and rejections
export function fetchSummary(): Promise<SummaryResponse> {
  return apiFetch<SummaryResponse>("/summary");
}

// GET /strategies - strategies.json content (symbols list)
export function fetchStrategies(): Promise<StrategiesResponse> {
  return apiFetch<StrategiesResponse>("/strategies");
}

// POST /backtest - run a historical backtest
export function runBacktest(
  from: string,
  to: string,
  strategy?: string
): Promise<BacktestResponse> {
  return apiFetch<BacktestResponse>("/backtest", {
    method: "POST",
    body: JSON.stringify({ from, to, strategy }),
  });
}

// PUT /strategies/symbols - add or remove a ticker
export function updateSymbol(
  strategyId: string,
  symbol: string,
  action: "add" | "remove"
): Promise<{ success: boolean; symbols: string[] }> {
  return apiFetch("/strategies/symbols", {
    method: "PUT",
    body: JSON.stringify({ strategyId, symbol, action }),
  });
}

// POST /restart - restart the strategy runner
export function restartBot(): Promise<{ success: boolean; message: string }> {
  return apiFetch("/restart", { method: "POST" });
}
