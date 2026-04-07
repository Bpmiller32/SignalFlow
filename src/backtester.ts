// backtester.ts - Historical strategy backtester
// Replays historical market data through the IStrategy interface.
// Uses the same strategies.json config as live trading.
// No Discord, no state files, no broker - pure simulation.
//
// Usage:
//   npx ts-node src/backtester.ts 2026-01-27 2026-01-30
//   npx ts-node src/backtester.ts 2026-01-27 2026-01-30 orb-fvg-default
//
// Args:
//   1: from date (YYYY-MM-DD)
//   2: to date (YYYY-MM-DD)
//   3: strategy id (optional, defaults to first enabled strategy)

import * as fs from "fs";
import * as path from "path";
import { addDays, isWeekend } from "date-fns";
import config from "./config";
import * as logger from "./logger";
import * as alpacaData from "./alpacaData";
import { IStrategy } from "./strategies/IStrategy";
import { createStrategy as createStrategyFromRegistry } from "./strategies/registry";
import {
  Candle,
  Position,
  PositionSize,
  StrategyConfig,
  StrategiesFile,
  PositionUpdate,
} from "./types";

// a completed backtest trade
interface BacktestTrade {
  date: string; // trading date
  symbol: string; // what was traded
  side: "LONG" | "SHORT"; // direction
  entryPrice: number; // entry price
  exitPrice: number; // exit price
  quantity: number; // shares traded
  pnl: number; // profit/loss in dollars
  pnlPercent: number; // profit/loss as %
  exitReason: string; // why it closed
  holdingMinutes: number; // how long held
  partialPnL: number; // P&L from partial exits
}

// simulated position during backtest
interface SimPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  entryTime: Date;
  stopLoss: number;
  takeProfit: number;
  initialStopLoss: number;
  highestPrice: number;
  lowestPrice: number;
  trailingStopActive: boolean;
  originalQuantity: number;
  partialExitExecuted: boolean;
  partialPnL: number; // accumulated P&L from partial exits
}

// backtest statistics
interface BacktestStats {
  totalDays: number;
  tradingDays: number; // days with data
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  averagePnL: number;
  bestTrade: number;
  worstTrade: number;
  maxDrawdown: number;
  profitFactor: number; // gross wins / gross losses
  averageHoldingMinutes: number;
  tradesPerDay: number;
  // capital requirements
  peakCapitalRequired: number; // most money tied up in positions at once on any single day
  totalCapitalDeployed: number; // sum of all position sizes across all trades
  returnOnCapital: number; // total P&L as % of peak capital required
  simulatedAccountSize: number; // the account size used in the simulation
  // per-symbol detailed breakdown
  symbolStats: { [symbol: string]: SymbolStats };
}

// detailed per-symbol statistics for evaluating which tickers to keep or drop
interface SymbolStats {
  trades: number; // total signals that triggered
  wins: number; // winning trades
  losses: number; // losing trades
  winRate: number; // win percentage
  totalPnL: number; // total dollar P&L
  avgPnL: number; // average P&L per trade
  bestTrade: number; // best single trade
  worstTrade: number; // worst single trade
  avgWin: number; // average winning trade P&L
  avgLoss: number; // average losing trade P&L
  profitFactor: number; // gross wins / gross losses
  longs: number; // how many long trades
  shorts: number; // how many short trades
  longWinRate: number; // win rate on longs
  shortWinRate: number; // win rate on shorts
  avgHoldingMinutes: number; // average trade duration
  signalRate: number; // % of trading days that generated a trade
  // exit reason breakdown
  exitReasons: { [reason: string]: number };
}

// parse command line args
function parseArgs(): { fromDate: string; toDate: string; strategyId: string | null } {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: npx ts-node src/backtester.ts <from-date> <to-date> [strategy-id]");
    console.log("Example: npx ts-node src/backtester.ts 2026-01-27 2026-01-30");
    process.exit(1);
  }
  return {
    fromDate: args[0],
    toDate: args[1],
    strategyId: args[2] || null,
  };
}

// load a strategy from strategies.json
function loadStrategy(strategyId: string | null): { strategy: IStrategy; stratConfig: StrategyConfig } {
  const jsonPath = path.join(process.cwd(), "strategies.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error("strategies.json not found");
  }
  const file: StrategiesFile = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  // find the strategy config by id, or use first enabled
  let stratConfig: StrategyConfig | undefined;
  if (strategyId) {
    stratConfig = file.strategies.find((s) => s.id === strategyId);
    if (!stratConfig) {
      throw new Error(`Strategy "${strategyId}" not found in strategies.json`);
    }
  } else {
    stratConfig = file.strategies.find((s) => s.enabled);
    if (!stratConfig) {
      throw new Error("No enabled strategies found in strategies.json");
    }
  }

  // create strategy instance using the registry
  const strategy = createStrategyFromRegistry(stratConfig, config);

  return { strategy, stratConfig };
}

// get all trading days between two dates (skip weekends)
function getTradingDays(fromDate: string, toDate: string): string[] {
  const days: string[] = [];
  // use noon UTC to avoid timezone edge cases
  let current = new Date(fromDate + "T12:00:00Z");
  const end = new Date(toDate + "T12:00:00Z");

  while (current <= end) {
    if (!isWeekend(current)) {
      const year = current.getFullYear();
      const month = String(current.getMonth() + 1).padStart(2, "0");
      const day = String(current.getDate()).padStart(2, "0");
      days.push(`${year}-${month}-${day}`);
    }
    current = addDays(current, 1);
  }

  return days;
}

// convert a PositionSize into a SimPosition for tracking
function createSimPosition(posSize: PositionSize, entryTime: Date): SimPosition {
  // determine side from entry vs target price
  const side = posSize.entryPrice < posSize.targetPrice ? "LONG" : "SHORT";
  return {
    symbol: posSize.symbol,
    side,
    entryPrice: posSize.entryPrice,
    quantity: posSize.quantity,
    entryTime,
    stopLoss: posSize.stopPrice,
    takeProfit: posSize.targetPrice,
    initialStopLoss: posSize.stopPrice,
    highestPrice: posSize.entryPrice,
    lowestPrice: posSize.entryPrice,
    trailingStopActive: false,
    originalQuantity: posSize.quantity,
    partialExitExecuted: false,
    partialPnL: 0,
  };
}

// convert a SimPosition to the Position type that evaluatePosition expects
function simToPosition(sim: SimPosition): Position {
  return {
    symbol: sim.symbol,
    side: sim.side,
    entryPrice: sim.entryPrice,
    quantity: sim.quantity,
    entryTime: sim.entryTime,
    stopLoss: sim.stopLoss,
    takeProfit: sim.takeProfit,
    orderIds: { entry: "BT", stopLoss: "BT", takeProfit: "BT" },
    initialStopLoss: sim.initialStopLoss,
    highestPrice: sim.highestPrice,
    lowestPrice: sim.lowestPrice,
    trailingStopActive: sim.trailingStopActive,
    originalQuantity: sim.originalQuantity,
    partialExitExecuted: sim.partialExitExecuted,
  };
}

// apply a PositionUpdate to a SimPosition, returns a trade if position closed
function applyUpdate(sim: SimPosition, update: PositionUpdate, candle: Candle): BacktestTrade | null {
  // handle partial exit
  if (update.doPartialExit && !sim.partialExitExecuted) {
    const exitQty = Math.floor(sim.originalQuantity * (update.partialExitPercent / 100));
    if (exitQty > 0) {
      let partialPnl = 0;
      if (sim.side === "LONG") {
        partialPnl = (update.partialExitPrice - sim.entryPrice) * exitQty;
      } else {
        partialPnl = (sim.entryPrice - update.partialExitPrice) * exitQty;
      }
      sim.partialPnL += partialPnl;
      sim.quantity -= exitQty;
      sim.partialExitExecuted = true;
    }
  }

  // activate trailing stop
  if (update.activateTrailing) {
    sim.trailingStopActive = true;
  }

  // update stop loss
  if (update.newStopLoss !== null) {
    sim.stopLoss = update.newStopLoss;
  }

  // update high/low tracking for trailing stops
  if (sim.side === "LONG") {
    sim.highestPrice = Math.max(candle.high, sim.highestPrice);
  } else {
    sim.lowestPrice = Math.min(candle.low, sim.lowestPrice);
  }

  // close position if requested
  if (update.closePosition) {
    // calculate P&L on remaining shares
    let remainingPnl = 0;
    if (sim.side === "LONG") {
      remainingPnl = (update.closePrice - sim.entryPrice) * sim.quantity;
    } else {
      remainingPnl = (sim.entryPrice - update.closePrice) * sim.quantity;
    }
    // total P&L includes partial exit profits
    const totalPnl = remainingPnl + sim.partialPnL;
    const holdingMs = candle.timestamp.getTime() - sim.entryTime.getTime();

    return {
      date: candle.timestamp.toISOString().split("T")[0],
      symbol: sim.symbol,
      side: sim.side,
      entryPrice: sim.entryPrice,
      exitPrice: update.closePrice,
      quantity: sim.originalQuantity,
      pnl: totalPnl,
      pnlPercent: (totalPnl / (sim.entryPrice * sim.originalQuantity)) * 100,
      exitReason: update.closeReason,
      holdingMinutes: Math.floor(holdingMs / 60000),
      partialPnL: sim.partialPnL,
    };
  }

  return null;
}

// compute statistics from all trades
function computeStats(trades: BacktestTrade[], totalDays: number, tradingDays: number): BacktestStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWins = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  // calculate max drawdown from peak equity
  let peak = 0;
  let maxDrawdown = 0;
  let cumPnL = 0;
  for (const trade of trades) {
    cumPnL += trade.pnl;
    if (cumPnL > peak) peak = cumPnL;
    const drawdown = peak - cumPnL;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // build detailed per-symbol stats
  const symbolStats = computeSymbolStats(trades, tradingDays);

  // calculate capital requirements from actual trade data
  // group trades by date and sum position values to find peak daily capital
  const tradesByDate: { [date: string]: number } = {};
  let totalCapitalDeployed = 0;
  for (const trade of trades) {
    const posValue = trade.entryPrice * trade.quantity;
    totalCapitalDeployed += posValue;
    tradesByDate[trade.date] = (tradesByDate[trade.date] || 0) + posValue;
  }
  // peak capital = most money tied up in positions on any single day
  const peakCapitalRequired = Object.values(tradesByDate).length > 0
    ? Math.max(...Object.values(tradesByDate))
    : 0;

  const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
  const returnOnCapital = peakCapitalRequired > 0 ? (totalPnL / peakCapitalRequired) * 100 : 0;

  return {
    totalDays,
    tradingDays,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnL,
    averagePnL: trades.length > 0 ? totalPnL / trades.length : 0,
    bestTrade: trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0,
    maxDrawdown,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    averageHoldingMinutes: trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdingMinutes, 0) / trades.length : 0,
    tradesPerDay: tradingDays > 0 ? trades.length / tradingDays : 0,
    peakCapitalRequired,
    totalCapitalDeployed,
    returnOnCapital,
    simulatedAccountSize: 100000,
    symbolStats,
  };
}

// compute detailed per-symbol stats from all trades
function computeSymbolStats(trades: BacktestTrade[], tradingDays: number): { [symbol: string]: SymbolStats } {
  // group trades by symbol
  const bySymbol: { [symbol: string]: BacktestTrade[] } = {};
  for (const trade of trades) {
    if (!bySymbol[trade.symbol]) {
      bySymbol[trade.symbol] = [];
    }
    bySymbol[trade.symbol].push(trade);
  }

  // compute stats for each symbol
  const result: { [symbol: string]: SymbolStats } = {};

  for (const [symbol, symbolTrades] of Object.entries(bySymbol)) {
    const symWins = symbolTrades.filter((t) => t.pnl > 0);
    const symLosses = symbolTrades.filter((t) => t.pnl <= 0);
    const symGrossWins = symWins.reduce((sum, t) => sum + t.pnl, 0);
    const symGrossLosses = Math.abs(symLosses.reduce((sum, t) => sum + t.pnl, 0));

    // long vs short breakdown
    const longTrades = symbolTrades.filter((t) => t.side === "LONG");
    const shortTrades = symbolTrades.filter((t) => t.side === "SHORT");
    const longWins = longTrades.filter((t) => t.pnl > 0).length;
    const shortWins = shortTrades.filter((t) => t.pnl > 0).length;

    // exit reason breakdown
    const exitReasons: { [reason: string]: number } = {};
    for (const t of symbolTrades) {
      exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
    }

    // average holding time
    const totalHoldingMinutes = symbolTrades.reduce((sum, t) => sum + t.holdingMinutes, 0);

    result[symbol] = {
      trades: symbolTrades.length,
      wins: symWins.length,
      losses: symLosses.length,
      winRate: symbolTrades.length > 0 ? (symWins.length / symbolTrades.length) * 100 : 0,
      totalPnL: symbolTrades.reduce((sum, t) => sum + t.pnl, 0),
      avgPnL: symbolTrades.length > 0 ? symbolTrades.reduce((sum, t) => sum + t.pnl, 0) / symbolTrades.length : 0,
      bestTrade: symbolTrades.length > 0 ? Math.max(...symbolTrades.map((t) => t.pnl)) : 0,
      worstTrade: symbolTrades.length > 0 ? Math.min(...symbolTrades.map((t) => t.pnl)) : 0,
      avgWin: symWins.length > 0 ? symGrossWins / symWins.length : 0,
      avgLoss: symLosses.length > 0 ? -symGrossLosses / symLosses.length : 0,
      profitFactor: symGrossLosses > 0 ? symGrossWins / symGrossLosses : symGrossWins > 0 ? Infinity : 0,
      longs: longTrades.length,
      shorts: shortTrades.length,
      longWinRate: longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0,
      shortWinRate: shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0,
      avgHoldingMinutes: symbolTrades.length > 0 ? totalHoldingMinutes / symbolTrades.length : 0,
      signalRate: tradingDays > 0 ? (symbolTrades.length / tradingDays) * 100 : 0,
      exitReasons,
    };
  }

  return result;
}

// print results to console in a formatted table
function printResults(stats: BacktestStats, trades: BacktestTrade[], stratConfig: StrategyConfig): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`BACKTEST RESULTS - ${stratConfig.id}`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Strategy: ${stratConfig.type}`);
  console.log(`Symbols: ${stratConfig.symbols.join(", ")}`);
  console.log(`Period: ${stats.totalDays} calendar days, ${stats.tradingDays} trading days`);
  console.log(`${"─".repeat(70)}`);

  // performance summary
  console.log(`\nPERFORMANCE SUMMARY`);
  console.log(`${"─".repeat(40)}`);
  console.log(`Total Trades:     ${stats.totalTrades}`);
  console.log(`Wins:             ${stats.wins}`);
  console.log(`Losses:           ${stats.losses}`);
  console.log(`Win Rate:         ${stats.winRate.toFixed(1)}%`);
  console.log(`Trades/Day:       ${stats.tradesPerDay.toFixed(2)}`);

  // P&L summary
  console.log(`\nP&L`);
  console.log(`${"─".repeat(40)}`);
  const pnlSign = stats.totalPnL >= 0 ? "+" : "";
  console.log(`Total P&L:        ${pnlSign}$${stats.totalPnL.toFixed(2)}`);
  console.log(`Average P&L:      ${stats.averagePnL >= 0 ? "+" : ""}$${stats.averagePnL.toFixed(2)}`);
  console.log(`Best Trade:       ${stats.bestTrade >= 0 ? "+" : ""}$${stats.bestTrade.toFixed(2)}`);
  console.log(`Worst Trade:      ${stats.worstTrade >= 0 ? "+" : ""}$${stats.worstTrade.toFixed(2)}`);
  console.log(`Max Drawdown:     -$${stats.maxDrawdown.toFixed(2)}`);
  console.log(`Profit Factor:    ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}`);

  // capital requirements
  console.log(`\nCAPITAL`);
  console.log(`${"─".repeat(40)}`);
  console.log(`Peak Capital:     $${stats.peakCapitalRequired.toFixed(2)} (most $ in positions on one day)`);
  console.log(`Total Deployed:   $${stats.totalCapitalDeployed.toFixed(2)} (sum of all position sizes)`);
  console.log(`Return on Capital: ${stats.returnOnCapital >= 0 ? "+" : ""}${stats.returnOnCapital.toFixed(2)}% (P&L / peak capital)`);
  console.log(`Simulated Acct:   $${stats.simulatedAccountSize.toLocaleString()}`);

  // timing
  console.log(`\nTIMING`);
  console.log(`${"─".repeat(40)}`);
  console.log(`Avg Hold Time:    ${stats.averageHoldingMinutes.toFixed(0)} minutes`);

  // ticker scorecard - detailed per-symbol analysis for keep/drop decisions
  console.log(`\nTICKER SCORECARD`);
  console.log(`${"═".repeat(70)}`);

  // sort symbols by total P&L (best performers first)
  const sortedSymbols = Object.entries(stats.symbolStats)
    .sort((a, b) => b[1].totalPnL - a[1].totalPnL);

  for (const [sym, s] of sortedSymbols) {
    const pSign = s.totalPnL >= 0 ? "+" : "";
    const emoji = s.totalPnL > 0 ? "🟢" : s.totalPnL < 0 ? "🔴" : "⚪";
    const pfStr = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);

    console.log(`\n${emoji} ${sym}`);
    console.log(`${"─".repeat(50)}`);

    // core performance
    console.log(`  Trades: ${s.trades} (${s.wins}W / ${s.losses}L) | Win Rate: ${s.winRate.toFixed(0)}%`);
    console.log(`  P&L:   ${pSign}$${s.totalPnL.toFixed(2)} | Avg: ${s.avgPnL >= 0 ? "+" : ""}$${s.avgPnL.toFixed(2)}/trade`);
    console.log(`  Best:  +$${s.bestTrade.toFixed(2)} | Worst: $${s.worstTrade.toFixed(2)}`);

    // edge quality
    console.log(`  Avg Win: +$${s.avgWin.toFixed(2)} | Avg Loss: $${s.avgLoss.toFixed(2)} | PF: ${pfStr}`);

    // direction breakdown
    if (s.longs > 0 || s.shorts > 0) {
      const longStr = s.longs > 0 ? `${s.longs}L (${s.longWinRate.toFixed(0)}% win)` : "0L";
      const shortStr = s.shorts > 0 ? `${s.shorts}S (${s.shortWinRate.toFixed(0)}% win)` : "0S";
      console.log(`  Sides: ${longStr} | ${shortStr}`);
    }

    // timing and activity
    console.log(`  Avg Hold: ${s.avgHoldingMinutes.toFixed(0)} min | Signal Rate: ${s.signalRate.toFixed(1)}% of days`);

    // exit reasons
    const reasonParts: string[] = [];
    for (const [reason, count] of Object.entries(s.exitReasons)) {
      reasonParts.push(`${reason}: ${count}`);
    }
    if (reasonParts.length > 0) {
      console.log(`  Exits: ${reasonParts.join(" | ")}`);
    }
  }

  // summary ranking table (compact one-line-per-symbol for quick scanning)
  console.log(`\n\nRANKING (sorted by P&L)`);
  console.log(`${"─".repeat(70)}`);
  console.log(`${"Symbol".padEnd(8)} ${"Trades".padStart(6)} ${"Win%".padStart(5)} ${"P&L".padStart(12)} ${"Avg P&L".padStart(10)} ${"PF".padStart(6)} ${"Signal%".padStart(8)}`);
  console.log(`${"─".repeat(70)}`);
  for (const [sym, s] of sortedSymbols) {
    const pSign = s.totalPnL >= 0 ? "+" : "";
    const aSign = s.avgPnL >= 0 ? "+" : "";
    const pfStr = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    console.log(
      `${sym.padEnd(8)} ${String(s.trades).padStart(6)} ${(s.winRate.toFixed(0) + "%").padStart(5)} ${(pSign + "$" + s.totalPnL.toFixed(2)).padStart(12)} ${(aSign + "$" + s.avgPnL.toFixed(2)).padStart(10)} ${pfStr.padStart(6)} ${(s.signalRate.toFixed(1) + "%").padStart(8)}`,
    );
  }

  // trade log
  if (trades.length > 0) {
    console.log(`\nTRADE LOG`);
    console.log(`${"─".repeat(70)}`);
    console.log(`${"Date".padEnd(12)} ${"Symbol".padEnd(8)} ${"Side".padEnd(6)} ${"Entry".padStart(10)} ${"Exit".padStart(10)} ${"P&L".padStart(12)} ${"Reason".padEnd(12)}`);
    console.log(`${"─".repeat(70)}`);
    for (const t of trades) {
      const tPnlSign = t.pnl >= 0 ? "+" : "";
      console.log(
        `${t.date.padEnd(12)} ${t.symbol.padEnd(8)} ${t.side.padEnd(6)} ${("$" + t.entryPrice.toFixed(2)).padStart(10)} ${("$" + t.exitPrice.toFixed(2)).padStart(10)} ${(tPnlSign + "$" + t.pnl.toFixed(2)).padStart(12)} ${t.exitReason.padEnd(12)}`,
      );
    }
  }

  console.log(`\n${"═".repeat(70)}\n`);
}

// exported function for programmatic use (called by discord bot /backtest command)
export async function runBacktestProgrammatic(
  fromDate: string,
  toDate: string,
  strategyId?: string,
): Promise<{ stats: any; trades: BacktestTrade[] }> {
  return await executeBacktest(fromDate, toDate, strategyId || null, false);
}

// main backtest function (shared by CLI and programmatic use)
// uses ONLY IStrategy interface methods - no strategy-specific calls
async function executeBacktest(
  fromDate: string,
  toDate: string,
  strategyId: string | null,
  printOutput: boolean,
): Promise<{ stats: any; trades: BacktestTrade[] }> {
  // always log to logger so backtest activity is recorded
  logger.normal(`📊 Starting backtest: ${fromDate} to ${toDate}`);
  if (printOutput) console.log(`\nStarting backtest: ${fromDate} to ${toDate}`);

  // load the strategy from strategies.json
  const { strategy, stratConfig } = loadStrategy(strategyId);
  logger.normal(`Backtest strategy: ${stratConfig.id} (${stratConfig.type}) | Symbols: ${stratConfig.symbols.join(", ")}`);
  if (printOutput) console.log(`Strategy: ${stratConfig.id} (${stratConfig.type})`);
  if (printOutput) console.log(`Symbols: ${stratConfig.symbols.join(", ")}`);

  // get trading days in range (weekdays only)
  const tradingDays = getTradingDays(fromDate, toDate);
  logger.normal(`Backtest trading days: ${tradingDays.length}`);
  if (printOutput) console.log(`Trading days: ${tradingDays.length}`);

  // collect all trades across all days
  const allTrades: BacktestTrade[] = [];
  let daysWithData = 0;

  // replay each trading day through the strategy
  for (const date of tradingDays) {
    logger.normal(`[${date}] Processing trading day...`);
    if (printOutput) process.stdout.write(`\r  Processing ${date}...`);

    // initialize strategy for this day (reset all internal state)
    strategy.initialize(stratConfig.symbols);

    // let the strategy set up for this date (fetches opening ranges, etc.)
    await strategy.onSessionStart(date);

    // process each symbol for the day
    for (const symbol of stratConfig.symbols) {
      try {
        // fetch 1-min candles for the trading day
        const candles1min = await alpacaData.fetch1MinCandles(symbol, date);
        if (candles1min.length === 0) {
          logger.normal(`[${date}] ${symbol} - No candle data, skipping`);
          continue;
        }

        // at least one symbol had data for this day
        daysWithData++;
        logger.normal(`[${date}] ${symbol} - ${candles1min.length} candles loaded`);

        // track simulated position and whether we've entered a trade
        let simPos: SimPosition | null = null;
        let tradeExecuted = false;

        // iterate through each 1-min candle
        for (const candle of candles1min) {
          // extract candle time for cutoff check (using candle timestamp, not wall clock)
          const candleHour = candle.timestamp.getHours();
          const candleMin = candle.timestamp.getMinutes();
          const candleTime = `${String(candleHour).padStart(2, "0")}:${String(candleMin).padStart(2, "0")}`;
          const isPastCutoff = candleTime >= stratConfig.schedule.tradingCutoff;

          // if we have an open position, evaluate it for stops/targets/trailing
          if (simPos) {
            const pos = simToPosition(simPos);
            const update = strategy.evaluatePosition(symbol, candle, pos);
            const trade = applyUpdate(simPos, update, candle);
            if (trade) {
              const tSign = trade.pnl >= 0 ? "+" : "";
              logger.normal(`[${date}] ${symbol} - EXIT @ ${candleTime} | ${trade.exitReason} | ${tSign}$${trade.pnl.toFixed(2)}`);
              allTrades.push(trade);
              simPos = null;
            }
            continue; // don't look for new signals while in a position
          }

          // skip if already traded today or past the cutoff time
          if (tradeExecuted || isPastCutoff) continue;

          // ask strategy what to do with this candle (generic interface call)
          const action = strategy.onCandle(symbol, candle, 100000);

          // handle the strategy's decision
          if (action.type === "ENTRY" && action.positionSize) {
            // strategy wants to enter a trade - create simulated position
            simPos = createSimPosition(action.positionSize, candle.timestamp);
            tradeExecuted = true;
            logger.normal(`[${date}] ${symbol} - ENTRY @ ${candleTime} | ${simPos.side} ${simPos.quantity} shares @ $${simPos.entryPrice.toFixed(2)} | Stop: $${simPos.stopLoss.toFixed(2)} Target: $${simPos.takeProfit.toFixed(2)}`);
          } else if (action.type === "DONE") {
            // strategy is done with this symbol for today
            logger.normal(`[${date}] ${symbol} - DONE @ ${candleTime} | ${action.reason}`);
            break;
          }
        }

        // end of day - close any remaining position at last candle's close
        if (simPos && candles1min.length > 0) {
          const lastCandle = candles1min[candles1min.length - 1];
          let pnl = 0;
          if (simPos.side === "LONG") {
            pnl = (lastCandle.close - simPos.entryPrice) * simPos.quantity;
          } else {
            pnl = (simPos.entryPrice - lastCandle.close) * simPos.quantity;
          }
          // add any partial exit profits
          pnl += simPos.partialPnL;
          const holdingMs = lastCandle.timestamp.getTime() - simPos.entryTime.getTime();
          const eodSign = pnl >= 0 ? "+" : "";
          logger.normal(`[${date}] ${symbol} - EOD CLOSE @ $${lastCandle.close.toFixed(2)} | ${eodSign}$${pnl.toFixed(2)}`);

          allTrades.push({
            date,
            symbol: simPos.symbol,
            side: simPos.side,
            entryPrice: simPos.entryPrice,
            exitPrice: lastCandle.close,
            quantity: simPos.originalQuantity,
            pnl,
            pnlPercent: (pnl / (simPos.entryPrice * simPos.originalQuantity)) * 100,
            exitReason: "END_OF_DAY",
            holdingMinutes: Math.floor(holdingMs / 60000),
            partialPnL: simPos.partialPnL,
          });
        }

        // log if no trade happened for this symbol today
        if (!tradeExecuted) {
          logger.normal(`[${date}] ${symbol} - No trade executed`);
        }
      } catch (error) {
        // skip symbols/days with data errors
        logger.normal(`[${date}] ${symbol} - ERROR: ${(error as Error).message}`);
        if (printOutput) console.log(`\n  Error on ${symbol} ${date}: ${(error as Error).message}`);
      }
    }

    // end the trading session (strategy resets internal state)
    strategy.onSessionEnd();
  }

  if (printOutput) console.log("\r" + " ".repeat(40) + "\r");

  // compute statistics from all collected trades
  const totalCalendarDays = Math.ceil(
    (new Date(toDate).getTime() - new Date(fromDate).getTime()) / (1000 * 60 * 60 * 24),
  ) + 1;

  const stats = computeStats(allTrades, totalCalendarDays, tradingDays.length);

  // always log summary to logger
  const pnlSign = stats.totalPnL >= 0 ? "+" : "";
  logger.normal(`📊 Backtest complete: ${stats.totalTrades} trades | ${stats.wins}W/${stats.losses}L | ${pnlSign}$${stats.totalPnL.toFixed(2)} | ${stats.winRate.toFixed(1)}% win rate`);

  // always save results to JSON file (both CLI and programmatic)
  const outputPath = path.join(process.cwd(), "data", `backtest-${fromDate}-to-${toDate}.json`);
  const output = { config: stratConfig, stats, trades: allTrades, runDate: new Date().toISOString() };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  logger.normal(`Backtest results saved to: ${outputPath}`);

  // print formatted table to console if CLI mode
  if (printOutput) {
    printResults(stats, allTrades, stratConfig);
    console.log(`Results saved to: ${outputPath}`);
  }

  return { stats, trades: allTrades };
}

// CLI entry point (only runs when executed directly, not when imported)
if (require.main === module) {
  const args = parseArgs();
  executeBacktest(args.fromDate, args.toDate, args.strategyId, true)
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error("Backtest failed:", err);
      process.exit(1);
    });
}
