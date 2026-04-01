//==============================================================================
// STATE.TS - FILE-BASED STATE MANAGEMENT AND PERSISTENCE
//==============================================================================
// This file implements the "stateless with a journal" design philosophy.
// All critical state is persisted to JSON files so the system can:
// - Survive crashes and restarts
// - Maintain history across sessions
// - Recover positions by syncing with broker on startup
// File structure:
//   data/state/{SYMBOL}-{DATE}-state.json          (daily state per symbol)
//   data/state/{SYMBOL}-current-position.json      (current position if open)
//   data/trades/{DATE}-trades.json                 (trade history for day)
//   data/trades/all-time-stats.json                (lifetime statistics)
// The broker API is always the source of truth - files are a cache/journal.
//==============================================================================

import * as fs from "fs";
import * as path from "path";
import {
  DailyState,
  CurrentPositionState,
  Trade,
  TradeHistory,
  AllTimeStats,
  TradingStats,
  Position,
  OpeningRange,
} from "./types";
import * as logger from "./logger";

//==============================================================================
// DIRECTORY SETUP
//==============================================================================

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_DIR = path.join(DATA_DIR, "state");
const TRADES_DIR = path.join(DATA_DIR, "trades");
const REJECTIONS_DIR = path.join(DATA_DIR, "rejections");

// Ensure all required directories exist.
// Creates them if they don't exist.

function ensureDirectories(): void {
  [DATA_DIR, STATE_DIR, TRADES_DIR, REJECTIONS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug(`Created directory: ${dir}`);
    }
  });
}

// Ensure directories exist on module load
ensureDirectories();

//==============================================================================
// DATE UTILITIES
//==============================================================================

// Get current date string in YYYY-MM-DD format (EST timezone).
// This is used for file naming consistency.

function getCurrentDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

//==============================================================================
// DAILY STATE MANAGEMENT
//==============================================================================

// Get the file path for a symbol's daily state file.

function getDailyStateFilePath(symbol: string, date?: string): string {
  const dateStr = date || getCurrentDateString();
  return path.join(STATE_DIR, `${symbol}-${dateStr}-state.json`);
}

// Load daily state for a symbol.
// Returns null if file doesn't exist (first run of the day).

export function loadDailyState(
  symbol: string,
  date?: string,
): DailyState | null {
  const filePath = getDailyStateFilePath(symbol, date);

  if (!fs.existsSync(filePath)) {
    logger.debug(`Daily state file not found: ${filePath}`);
    return null;
  }

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    const state: DailyState = JSON.parse(fileContent);

    // Convert timestamp strings back to Date objects
    if (state.openingRange) {
      state.openingRange.timestamp = new Date(state.openingRange.timestamp);
    }
    state.lastUpdated = new Date(state.lastUpdated);

    logger.debug(
      `Loaded daily state for ${symbol}: Session=${state.sessionStatus}, Traded=${state.tradeExecutedToday}`,
    );
    return state;
  } catch (error) {
    logger.error(`Failed to load daily state for ${symbol}`, error as Error);
    return null;
  }
}

// Save daily state for a symbol.

export function saveDailyState(state: DailyState): void {
  const filePath = getDailyStateFilePath(state.symbol, state.date);

  try {
    // Update last updated timestamp
    state.lastUpdated = new Date();

    const fileContent = JSON.stringify(state, null, 2);
    fs.writeFileSync(filePath, fileContent, "utf8");

    logger.debug(
      `Saved daily state for ${state.symbol}: Session=${state.sessionStatus}, Traded=${state.tradeExecutedToday}`,
    );
  } catch (error) {
    logger.error(
      `Failed to save daily state for ${state.symbol}`,
      error as Error,
    );
  }
}

// Create initial daily state for a new trading day.

export function createDailyState(symbol: string): DailyState {
  const state: DailyState = {
    date: getCurrentDateString(),
    symbol,
    openingRange: null,
    openingRangeCandle: undefined,
    tradeExecutedToday: false,
    tradeCount: 0,
    sessionStatus: "WAITING",
    lastUpdated: new Date(),
  };

  saveDailyState(state);
  logger.normal(`Created new daily state for ${symbol}`);

  return state;
}

// Update opening range in daily state.

export function updateOpeningRange(
  symbol: string,
  openingRange: OpeningRange,
): void {
  const state = loadDailyState(symbol) || createDailyState(symbol);
  state.openingRange = openingRange;
  state.sessionStatus = "MONITORING";
  saveDailyState(state);

  logger.normal(
    `Updated opening range for ${symbol}: ${openingRange.high} / ${openingRange.low}`,
  );
}

// Mark that a trade was executed today for a symbol.

export function markTradeExecuted(symbol: string): void {
  const state = loadDailyState(symbol) || createDailyState(symbol);
  state.tradeExecutedToday = true;
  state.sessionStatus = "DONE";
  saveDailyState(state);

  logger.normal(`Marked trade executed for ${symbol}`);
}

//==============================================================================
// CURRENT POSITION STATE MANAGEMENT
//==============================================================================

// Get the file path for a symbol's current position file.

function getCurrentPositionFilePath(symbol: string): string {
  return path.join(STATE_DIR, `${symbol}-current-position.json`);
}

// Load current position for a symbol.
// Returns null if no position file exists.

export function loadCurrentPosition(
  symbol: string,
): CurrentPositionState | null {
  const filePath = getCurrentPositionFilePath(symbol);

  if (!fs.existsSync(filePath)) {
    logger.debug(`No current position file for ${symbol}`);
    return null;
  }

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    const position: CurrentPositionState = JSON.parse(fileContent);

    // Convert timestamp strings back to Date objects
    position.entryTime = new Date(position.entryTime);

    logger.debug(
      `Loaded current position for ${symbol}: ${position.side} ${position.quantity} shares @ ${position.entryPrice}`,
    );
    return position;
  } catch (error) {
    logger.error(
      `Failed to load current position for ${symbol}`,
      error as Error,
    );
    return null;
  }
}

// Save current position for a symbol.

export function saveCurrentPosition(
  position: CurrentPositionState | Position,
): void {
  const filePath = getCurrentPositionFilePath(position.symbol);

  try {
    const fileContent = JSON.stringify(position, null, 2);
    fs.writeFileSync(filePath, fileContent, "utf8");

    logger.debug(
      `Saved current position for ${position.symbol}: ${position.side} ${position.quantity} shares`,
    );
  } catch (error) {
    logger.error(
      `Failed to save current position for ${position.symbol}`,
      error as Error,
    );
  }
}

// Delete current position file for a symbol (called when position closed).

export function deleteCurrentPosition(symbol: string): void {
  const filePath = getCurrentPositionFilePath(symbol);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      logger.debug(`Deleted current position file for ${symbol}`);
    } catch (error) {
      logger.error(
        `Failed to delete current position file for ${symbol}`,
        error as Error,
      );
    }
  }
}

//==============================================================================
// TRADE HISTORY MANAGEMENT
//==============================================================================

// Get the file path for a date's trade history file.

function getTradeHistoryFilePath(date?: string): string {
  const dateStr = date || getCurrentDateString();
  return path.join(TRADES_DIR, `${dateStr}-trades.json`);
}

// Load trade history for a specific date.

export function loadTradeHistory(date?: string): TradeHistory | null {
  const filePath = getTradeHistoryFilePath(date);

  if (!fs.existsSync(filePath)) {
    logger.debug(`No trade history file for ${date || "today"}`);
    return null;
  }

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    const history: TradeHistory = JSON.parse(fileContent);

    // Convert timestamp strings back to Date objects
    history.trades.forEach((trade) => {
      trade.entryTime = new Date(trade.entryTime);
      trade.exitTime = new Date(trade.exitTime);
    });

    logger.debug(
      `Loaded trade history for ${date || "today"}: ${history.trades.length} trades`,
    );
    return history;
  } catch (error) {
    logger.error(
      `Failed to load trade history for ${date || "today"}`,
      error as Error,
    );
    return null;
  }
}

// Save a completed trade to history.

export function saveTradeToHistory(trade: Trade): void {
  const dateStr = getCurrentDateString();
  const filePath = getTradeHistoryFilePath(dateStr);

  let history: TradeHistory;

  if (fs.existsSync(filePath)) {
    // Load existing history
    const fileContent = fs.readFileSync(filePath, "utf8");
    history = JSON.parse(fileContent);
  } else {
    // Create new history
    history = {
      date: dateStr,
      trades: [],
    };
  }

  // Add new trade
  history.trades.push(trade);

  // Save back to file
  try {
    const fileContent = JSON.stringify(history, null, 2);
    fs.writeFileSync(filePath, fileContent, "utf8");
    logger.normal(
      `Saved trade to history: ${trade.symbol} ${trade.side} | P&L: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}`,
    );
  } catch (error) {
    logger.error("Failed to save trade to history", error as Error);
  }
}

//==============================================================================
// STATISTICS MANAGEMENT
//==============================================================================

// Get file path for all-time statistics.

function getAllTimeStatsFilePath(): string {
  return path.join(DATA_DIR, "all-time-stats.json");
}

// Create initial empty statistics.

function createEmptyStats(): TradingStats {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnL: 0,
    bestTrade: 0,
    worstTrade: 0,
    averageWin: 0,
    averageLoss: 0,
    currentStreak: { type: "WIN", count: 0 },
    longestWinStreak: 0,
    longestLossStreak: 0,
  };
}

// Load all-time statistics.

export function loadAllTimeStats(): AllTimeStats {
  const filePath = getAllTimeStatsFilePath();

  if (!fs.existsSync(filePath)) {
    logger.debug("No all-time stats file found, creating new");
    return {
      allTimeStats: createEmptyStats(),
      symbolStats: {},
      lastUpdated: new Date(),
    };
  }

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    const stats: AllTimeStats = JSON.parse(fileContent);
    stats.lastUpdated = new Date(stats.lastUpdated);
    return stats;
  } catch (error) {
    logger.error("Failed to load all-time stats", error as Error);
    return {
      allTimeStats: createEmptyStats(),
      symbolStats: {},
      lastUpdated: new Date(),
    };
  }
}

// Update statistics with a new trade.

export function updateStatistics(trade: Trade): void {
  const allStats = loadAllTimeStats();

  // Update overall stats
  updateStatsWithTrade(allStats.allTimeStats, trade);

  // Update per-symbol stats
  if (!allStats.symbolStats[trade.symbol]) {
    allStats.symbolStats[trade.symbol] = createEmptyStats();
  }
  updateStatsWithTrade(allStats.symbolStats[trade.symbol], trade);

  // Save updated stats
  allStats.lastUpdated = new Date();

  try {
    const fileContent = JSON.stringify(allStats, null, 2);
    fs.writeFileSync(getAllTimeStatsFilePath(), fileContent, "utf8");
    logger.debug(
      `Updated statistics: Total trades=${allStats.allTimeStats.totalTrades}, Win rate=${allStats.allTimeStats.winRate.toFixed(1)}%`,
    );
  } catch (error) {
    logger.error("Failed to save statistics", error as Error);
  }
}

// Helper function to update a TradingStats object with a new trade.

function updateStatsWithTrade(stats: TradingStats, trade: Trade): void {
  const isWin = trade.pnl > 0;

  // Update counts
  stats.totalTrades++;
  if (isWin) {
    stats.wins++;
  } else if (trade.pnl < 0) {
    stats.losses++;
  }

  // Update win rate
  stats.winRate = (stats.wins / stats.totalTrades) * 100;

  // Update P&L
  stats.totalPnL += trade.pnl;

  // Update best/worst
  if (trade.pnl > stats.bestTrade) {
    stats.bestTrade = trade.pnl;
  }
  if (trade.pnl < stats.worstTrade) {
    stats.worstTrade = trade.pnl;
  }

  // Update averages
  if (stats.wins > 0) {
    // Recalculate average win (need to track sum, not just average)
    // For simplicity, we'll approximate by incremental update
    const oldWinSum = stats.averageWin * (stats.wins - (isWin ? 1 : 0));
    const newWinSum = oldWinSum + (isWin ? trade.pnl : 0);
    stats.averageWin = stats.wins > 0 ? newWinSum / stats.wins : 0;
  }

  if (stats.losses > 0) {
    const oldLossSum =
      stats.averageLoss * (stats.losses - (!isWin && trade.pnl < 0 ? 1 : 0));
    const newLossSum = oldLossSum + (!isWin && trade.pnl < 0 ? trade.pnl : 0);
    stats.averageLoss = stats.losses > 0 ? newLossSum / stats.losses : 0;
  }

  // Update streaks
  if (isWin) {
    if (stats.currentStreak.type === "WIN") {
      stats.currentStreak.count++;
    } else {
      stats.currentStreak = { type: "WIN", count: 1 };
    }
    if (stats.currentStreak.count > stats.longestWinStreak) {
      stats.longestWinStreak = stats.currentStreak.count;
    }
  } else if (trade.pnl < 0) {
    if (stats.currentStreak.type === "LOSS") {
      stats.currentStreak.count++;
    } else {
      stats.currentStreak = { type: "LOSS", count: 1 };
    }
    if (stats.currentStreak.count > stats.longestLossStreak) {
      stats.longestLossStreak = stats.currentStreak.count;
    }
  }
}

//==============================================================================
// STARTUP RECOVERY
//==============================================================================

// Perform startup recovery for a symbol.
// This reconciles file state with broker state to handle crashes/restarts.
// Steps:
// 1. Load daily state and position from files
// 2. Query broker for actual positions
// 3. Reconcile differences (broker is source of truth)
// 4. Return recovered state

export function performStartupRecovery(
  symbol: string,
  brokerPosition: Position | null,
): { dailyState: DailyState; position: Position | null } {
  logger.normal(`Performing startup recovery for ${symbol}...`);

  // Load file states
  const fileState = loadDailyState(symbol);
  const filePosition = loadCurrentPosition(symbol);

  // Create or use existing daily state
  const dailyState = fileState || createDailyState(symbol);

  // Reconcile positions
  let recoveredPosition: Position | null = null;

  if (brokerPosition && filePosition) {
    // Both have position - verify they match
    if (
      brokerPosition.side === filePosition.side &&
      brokerPosition.quantity === filePosition.quantity
    ) {
      logger.normal(
        `Position verified: ${symbol} ${brokerPosition.side} ${brokerPosition.quantity} shares`,
      );
      recoveredPosition = brokerPosition;
    } else {
      logger.normal(
        `Position mismatch detected - using broker state (source of truth)`,
      );
      recoveredPosition = brokerPosition;
      saveCurrentPosition(brokerPosition);
    }
  } else if (brokerPosition && !filePosition) {
    // Broker has position but file doesn't - external position or file was deleted
    logger.normal(
      `Position found in broker but not in file - assuming external position`,
    );
    recoveredPosition = brokerPosition;
    saveCurrentPosition(brokerPosition);
  } else if (!brokerPosition && filePosition) {
    // File has position but broker doesn't - position was closed externally or broker lost it
    logger.normal(
      `Position in file but not in broker - assuming closed externally`,
    );
    deleteCurrentPosition(symbol);
    markTradeExecuted(symbol); // Prevent reentry today
    recoveredPosition = null;
  } else {
    // Neither has position - normal state
    logger.debug(`No position for ${symbol} - normal state`);
    recoveredPosition = null;
  }

  logger.normal(`Startup recovery complete for ${symbol}`);

  return {
    dailyState,
    position: recoveredPosition,
  };
}

//==============================================================================
// REJECTION LOGGING
//==============================================================================

// Log rejection for later analysis (why trades were rejected).

export function logRejection(
  symbol: string,
  stage: import("./types").RejectionStage,
  reason: string,
  details?: any,
): void {
  try {
    const date = getCurrentDateString();
    const filePath = path.join(REJECTIONS_DIR, `${date}.json`);

    // Load existing or create new
    let log: import("./types").RejectionLog;
    if (fs.existsSync(filePath)) {
      log = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } else {
      log = { date, rejections: [] };
    }

    log.rejections.push({ timestamp: new Date(), symbol, stage, reason, details });
    fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
  } catch (error) {
    logger.error("Failed to log rejection", error as Error);
  }
}

// Get rejection summary for end-of-day reporting.

export function getRejectionSummary(date: string): {
  total: number;
  byStage: { [key: string]: number };
  bySymbol: { [key: string]: number };
} {
  try {
    const filePath = path.join(REJECTIONS_DIR, `${date}.json`);
    if (!fs.existsSync(filePath)) {
      return { total: 0, byStage: {}, bySymbol: {} };
    }

    const log: import("./types").RejectionLog = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    );
    const byStage: { [key: string]: number } = {};
    const bySymbol: { [key: string]: number } = {};

    log.rejections.forEach((r) => {
      byStage[r.stage] = (byStage[r.stage] || 0) + 1;
      bySymbol[r.symbol] = (bySymbol[r.symbol] || 0) + 1;
    });

    return { total: log.rejections.length, byStage, bySymbol };
  } catch (error) {
    logger.error("Failed to get rejection summary", error as Error);
    return { total: 0, byStage: {}, bySymbol: {} };
  }
}
