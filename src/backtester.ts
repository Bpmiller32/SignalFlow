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
import * as alpacaData from "./alpacaData";
import { IStrategy } from "./strategies/IStrategy";
import { ORBStrategy } from "./strategies/orbStrategy";
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
  // per-symbol breakdown
  symbolStats: { [symbol: string]: { trades: number; pnl: number; winRate: number } };
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

  // find the strategy config
  let stratConfig: StrategyConfig | undefined;
  if (strategyId) {
    stratConfig = file.strategies.find((s) => s.id === strategyId);
    if (!stratConfig) {
      throw new Error(`Strategy "${strategyId}" not found in strategies.json`);
    }
  } else {
    // use first enabled strategy
    stratConfig = file.strategies.find((s) => s.enabled);
    if (!stratConfig) {
      throw new Error("No enabled strategies found in strategies.json");
    }
  }

  // create strategy instance
  let strategy: IStrategy;
  switch (stratConfig.type) {
    case "opening-range-breakout":
      strategy = new ORBStrategy(stratConfig, config);
      break;
    default:
      throw new Error(`Unknown strategy type: ${stratConfig.type}`);
  }

  return { strategy, stratConfig };
}

// get all trading days between two dates (skip weekends)
function getTradingDays(fromDate: string, toDate: string): string[] {
  const days: string[] = [];
  let current = new Date(fromDate + "T12:00:00Z"); // noon UTC to avoid timezone issues
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
  // partial exit
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

  // activate trailing
  if (update.activateTrailing) {
    sim.trailingStopActive = true;
  }

  // update stop loss
  if (update.newStopLoss !== null) {
    sim.stopLoss = update.newStopLoss;
  }

  // update high/low tracking
  if (sim.side === "LONG") {
    sim.highestPrice = Math.max(candle.high, sim.highestPrice);
  } else {
    sim.lowestPrice = Math.min(candle.low, sim.lowestPrice);
  }

  // close position
  if (update.closePosition) {
    let remainingPnl = 0;
    if (sim.side === "LONG") {
      remainingPnl = (update.closePrice - sim.entryPrice) * sim.quantity;
    } else {
      remainingPnl = (sim.entryPrice - update.closePrice) * sim.quantity;
    }
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

  // max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let cumPnL = 0;
  for (const trade of trades) {
    cumPnL += trade.pnl;
    if (cumPnL > peak) peak = cumPnL;
    const drawdown = peak - cumPnL;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // per-symbol stats
  const symbolStats: { [key: string]: { trades: number; pnl: number; wins: number } } = {};
  for (const trade of trades) {
    if (!symbolStats[trade.symbol]) {
      symbolStats[trade.symbol] = { trades: 0, pnl: 0, wins: 0 };
    }
    symbolStats[trade.symbol].trades++;
    symbolStats[trade.symbol].pnl += trade.pnl;
    if (trade.pnl > 0) symbolStats[trade.symbol].wins++;
  }

  // format symbol stats with win rate
  const symbolStatsFormatted: { [key: string]: { trades: number; pnl: number; winRate: number } } = {};
  for (const [sym, s] of Object.entries(symbolStats)) {
    symbolStatsFormatted[sym] = {
      trades: s.trades,
      pnl: s.pnl,
      winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
    };
  }

  return {
    totalDays,
    tradingDays,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnL: trades.reduce((sum, t) => sum + t.pnl, 0),
    averagePnL: trades.length > 0 ? trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length : 0,
    bestTrade: trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0,
    maxDrawdown,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    averageHoldingMinutes: trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdingMinutes, 0) / trades.length : 0,
    tradesPerDay: tradingDays > 0 ? trades.length / tradingDays : 0,
    symbolStats: symbolStatsFormatted,
  };
}

// print results to console
function printResults(stats: BacktestStats, trades: BacktestTrade[], stratConfig: StrategyConfig): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`BACKTEST RESULTS - ${stratConfig.id}`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Strategy: ${stratConfig.type}`);
  console.log(`Symbols: ${stratConfig.symbols.join(", ")}`);
  console.log(`Period: ${stats.totalDays} calendar days, ${stats.tradingDays} trading days`);
  console.log(`${"─".repeat(70)}`);

  // summary
  console.log(`\nPERFORMANCE SUMMARY`);
  console.log(`${"─".repeat(40)}`);
  console.log(`Total Trades:     ${stats.totalTrades}`);
  console.log(`Wins:             ${stats.wins}`);
  console.log(`Losses:           ${stats.losses}`);
  console.log(`Win Rate:         ${stats.winRate.toFixed(1)}%`);
  console.log(`Trades/Day:       ${stats.tradesPerDay.toFixed(2)}`);

  // P&L
  console.log(`\nP&L`);
  console.log(`${"─".repeat(40)}`);
  const pnlSign = stats.totalPnL >= 0 ? "+" : "";
  console.log(`Total P&L:        ${pnlSign}$${stats.totalPnL.toFixed(2)}`);
  console.log(`Average P&L:      ${stats.averagePnL >= 0 ? "+" : ""}$${stats.averagePnL.toFixed(2)}`);
  console.log(`Best Trade:       ${stats.bestTrade >= 0 ? "+" : ""}$${stats.bestTrade.toFixed(2)}`);
  console.log(`Worst Trade:      ${stats.worstTrade >= 0 ? "+" : ""}$${stats.worstTrade.toFixed(2)}`);
  console.log(`Max Drawdown:     -$${stats.maxDrawdown.toFixed(2)}`);
  console.log(`Profit Factor:    ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}`);

  // timing
  console.log(`\nTIMING`);
  console.log(`${"─".repeat(40)}`);
  console.log(`Avg Hold Time:    ${stats.averageHoldingMinutes.toFixed(0)} minutes`);

  // per-symbol
  console.log(`\nPER-SYMBOL BREAKDOWN`);
  console.log(`${"─".repeat(40)}`);
  for (const [sym, s] of Object.entries(stats.symbolStats)) {
    const symPnlSign = s.pnl >= 0 ? "+" : "";
    console.log(`${sym.padEnd(8)} ${String(s.trades).padStart(3)} trades  ${(symPnlSign + "$" + s.pnl.toFixed(2)).padStart(12)}  ${s.winRate.toFixed(0)}% win`);
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

// main backtest function
async function runBacktest(): Promise<void> {
  const args = parseArgs();
  console.log(`\nStarting backtest: ${args.fromDate} to ${args.toDate}`);

  // load the strategy
  const { strategy, stratConfig } = loadStrategy(args.strategyId);
  console.log(`Strategy: ${stratConfig.id} (${stratConfig.type})`);
  console.log(`Symbols: ${stratConfig.symbols.join(", ")}`);

  // get trading days in range
  const tradingDays = getTradingDays(args.fromDate, args.toDate);
  console.log(`Trading days: ${tradingDays.length}`);

  // track all trades
  const allTrades: BacktestTrade[] = [];
  let daysWithData = 0;

  // run each trading day
  for (const date of tradingDays) {
    process.stdout.write(`\r  Processing ${date}...`);

    // initialize strategy for this day
    strategy.initialize(stratConfig.symbols);

    // process each symbol
    for (const symbol of stratConfig.symbols) {
      try {
        // fetch 5-min candles for opening range
        const candles5min = await alpacaData.fetch5MinCandles(symbol, date);
        if (candles5min.length === 0) continue;

        daysWithData++;
        const openingCandle = candles5min[0];

        // fetch previous day close for gap detection
        let prevClose: number | null = null;
        try {
          const dailyCandles = await alpacaData.fetchDailyCandles(symbol, 2);
          if (dailyCandles.length >= 1) {
            prevClose = dailyCandles[dailyCandles.length - 1].close;
          }
        } catch (e) {
          // skip gap check if no previous close
        }

        // evaluate opening range
        const orResult = strategy.evaluateOpeningRange(symbol, openingCandle, prevClose);
        if (!orResult.accepted) continue;

        // fetch 1-min candles for the rest of the day
        const candles1min = await alpacaData.fetch1MinCandles(symbol, date);
        if (candles1min.length === 0) continue;

        // state for this symbol today
        let simPos: SimPosition | null = null;
        let tradeExecuted = false;

        // iterate through 1-min candles
        for (const candle of candles1min) {
          // check cutoff time (based on candle time, not wall clock)
          const candleHour = candle.timestamp.getHours();
          const candleMin = candle.timestamp.getMinutes();
          const candleTime = `${String(candleHour).padStart(2, "0")}:${String(candleMin).padStart(2, "0")}`;
          const isPastCutoff = candleTime >= stratConfig.schedule.tradingCutoff;

          // if we have a position, evaluate it
          if (simPos) {
            const pos = simToPosition(simPos);
            const update = strategy.evaluatePosition(symbol, candle, pos);
            const trade = applyUpdate(simPos, update, candle);
            if (trade) {
              allTrades.push(trade);
              simPos = null;
            }
            continue;
          }

          // skip if already traded or past cutoff
          if (tradeExecuted || isPastCutoff) continue;

          // process candle for signals
          const result = strategy.processCandle(symbol, candle);

          // if signal generated, create simulated position
          if (result.signal && result.fvgPattern && orResult.openingRange) {
            const posSize = strategy.calculatePositionSize(
              symbol,
              result.signal,
              orResult.openingRange,
              result.fvgPattern,
              100000, // simulated $100k account
            );

            if (posSize) {
              simPos = createSimPosition(posSize, candle.timestamp);
              tradeExecuted = true;
            }
          }

          // if strategy says done, stop processing this symbol
          if (result.done && !result.signal) break;
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
          pnl += simPos.partialPnL;
          const holdingMs = lastCandle.timestamp.getTime() - simPos.entryTime.getTime();

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
      } catch (error) {
        // skip symbols/days with data errors
        console.log(`\n  Error on ${symbol} ${date}: ${(error as Error).message}`);
      }
    }
  }

  console.log("\r" + " ".repeat(40) + "\r"); // clear progress line

  // compute statistics
  const totalCalendarDays = Math.ceil(
    (new Date(args.toDate).getTime() - new Date(args.fromDate).getTime()) / (1000 * 60 * 60 * 24),
  ) + 1;
  // deduplicate daysWithData (was incrementing per symbol, should be per day)
  const uniqueDaysWithData = new Set(allTrades.map((t) => t.date)).size || (daysWithData > 0 ? Math.min(daysWithData / stratConfig.symbols.length, tradingDays.length) : 0);

  const stats = computeStats(allTrades, totalCalendarDays, tradingDays.length);

  // print results
  printResults(stats, allTrades, stratConfig);

  // save results to file
  const outputPath = path.join(process.cwd(), "data", `backtest-${args.fromDate}-to-${args.toDate}.json`);
  const output = { config: stratConfig, stats, trades: allTrades, runDate: new Date().toISOString() };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results saved to: ${outputPath}`);
}

// run
runBacktest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backtest failed:", err);
    process.exit(1);
  });
