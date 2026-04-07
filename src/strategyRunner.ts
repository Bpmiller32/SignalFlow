// strategyRunner.ts - Strategy orchestrator
// Loads strategies from JSON config, runs the market lifecycle, delegates decisions to strategies.
// This handles all I/O: candle fetching, trade execution, Discord, state persistence.
// Strategies are pure decision-makers. This runner executes their decisions.

import * as fs from "fs";
import config from "./config";
import * as logger from "./logger";
import * as timeUtils from "./timeUtils";
import * as discord from "./discordMessages";
import * as alpacaData from "./alpacaData";
import * as paperBroker from "./paperBroker";
import * as state from "./state";
import { IStrategy } from "./strategies/IStrategy";
import { ORBStrategy } from "./strategies/orbStrategy";
import {
  Position,
  StrategyConfig,
  StrategiesFile,
} from "./types";

// resolved channel IDs for a strategy (resolved from env var names)
interface ResolvedChannels {
  trades: string; // resolved channel ID for trades
  system: string; // resolved channel ID for system
  errors: string; // resolved channel ID for errors
}

// entry in the strategies list
interface StrategyEntry {
  strategy: IStrategy; // the strategy instance
  config: StrategyConfig; // its JSON config
  channels: ResolvedChannels; // resolved discord channel IDs
}

// per-symbol tracking state managed by the runner (not the strategy)
interface SymbolTracking {
  strategyId: string; // which strategy owns this
  symbol: string; // the symbol
  position: Position | null; // current open position
  done: boolean; // done trading this symbol today
  tradeExecutedToday: boolean; // has a trade been executed
  lastCandleTimestamp: Date | null; // last candle we processed (dedup)
}

export class StrategyRunner {
  // global config from .env
  private globalConfig = config;

  // loaded strategies
  private strategies: StrategyEntry[] = [];

  // per strategy+symbol tracking (key: "strategyId:symbol")
  private tracking: Map<string, SymbolTracking> = new Map();

  // stop flag for graceful shutdown via /restart command
  private stopRequested = false;

  // current status string for /status command
  private currentStatus = "Initializing";

  // load strategies from JSON file, create strategy instances
  loadStrategies(jsonPath: string): void {
    logger.normal(`Loading strategies from ${jsonPath}`);

    // read and parse the JSON file
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Strategies file not found: ${jsonPath}`);
    }
    const raw = fs.readFileSync(jsonPath, "utf8");
    const file: StrategiesFile = JSON.parse(raw);

    // create strategy instances for each enabled config
    for (const stratConfig of file.strategies) {
      if (!stratConfig.enabled) {
        logger.normal(`Strategy "${stratConfig.id}" is disabled, skipping`);
        continue;
      }

      // create the right strategy class based on type
      const strategyInstance = this.createStrategy(stratConfig);
      // resolve discord channel env var names to actual channel IDs
      const channels = this.resolveChannels(stratConfig);
      this.strategies.push({ strategy: strategyInstance, config: stratConfig, channels });
      logger.normal(`Loaded strategy: ${stratConfig.id} (${stratConfig.type}) for ${stratConfig.symbols.length} symbols`);
    }

    if (this.strategies.length === 0) {
      throw new Error("No enabled strategies found in config");
    }

    logger.normal(`${this.strategies.length} strategy(s) loaded`);
  }

  // run the full trading session lifecycle
  async run(): Promise<void> {
    try {
      await this.startup();
      await this.waitForMarketOpen();
      await this.sendMarketOpenSummary();
      // let each strategy do its session setup (fetch data, evaluate conditions)
      const today = timeUtils.getTodayDateString();
      for (const entry of this.strategies) {
        // wait until this strategy's setup window ends before starting
        await this.waitUntilTime(entry.config.schedule.sessionSetupEnd);
        await entry.strategy.onSessionStart(today);
      }
      await this.monitoringLoop();
      await this.shutdown();
    } catch (error) {
      logger.error("Critical error in strategy runner", error as Error);
      await discord.sendError("CRITICAL ERROR", (error as Error).message);
      throw error;
    }
  }

  //============================================================================
  // LIFECYCLE METHODS
  //============================================================================

  // initialize broker, strategies, recovery
  private async startup(): Promise<void> {
    logger.separator();
    logger.normal(`🚀 SignalFlow Started | Mode: ${this.globalConfig.mode}`);
    logger.separator();

    // send discord startup with all symbols across all strategies
    const allSymbols = this.getAllSymbols();
    await discord.sendStartup(this.globalConfig.mode, allSymbols);

    // init paper broker
    if (this.globalConfig.mode === "PAPER") {
      paperBroker.initializePaperBroker(100000);
      logger.normal("Paper broker initialized with $100,000");
    }

    // initialize each strategy and set up tracking
    for (const entry of this.strategies) {
      const symbols = entry.config.symbols;
      entry.strategy.initialize(symbols);

      for (const symbol of symbols) {
        // check broker for existing positions
        let brokerPosition: Position | null = null;
        if (this.globalConfig.mode === "PAPER") {
          brokerPosition = paperBroker.getPosition(symbol);
        }

        // perform startup recovery (reconcile file state with broker state)
        const recovery = state.performStartupRecovery(symbol, brokerPosition);

        // create tracking entry
        const key = this.trackingKey(entry.config.id, symbol);
        this.tracking.set(key, {
          strategyId: entry.config.id,
          symbol,
          position: recovery.position,
          done: recovery.dailyState.sessionStatus === "DONE",
          tradeExecutedToday: recovery.dailyState.tradeExecutedToday,
          lastCandleTimestamp: null,
        });

        logger.normal(`${symbol} initialized: session=${recovery.dailyState.sessionStatus}, position=${recovery.position ? "YES" : "NO"}`);
      }
    }

    logger.normal("System initialization complete");
  }

  // wait for market to open
  private async waitForMarketOpen(): Promise<void> {
    this.currentStatus = "Waiting for market open";
    while (true) {
      if (this.stopRequested) return;
      const marketHours = timeUtils.getMarketHours();
      if (marketHours.isOpen) {
        logger.normal("Market is open - starting trading session");
        await discord.sendMarketStatus("Market Open");
        return;
      }

      const hours = marketHours.hoursUntilOpen;
      logger.normal(`Market closed - opening in ${hours.toFixed(1)} hours`);

      // poll less frequently when far from open
      const waitTime = hours > 1 ? 300000 : 60000;
      await this.sleep(waitTime);
    }
  }

  // send a summary message at market open
  private async sendMarketOpenSummary(): Promise<void> {
    const allSymbols = this.getAllSymbols();
    // use the first strategy's cutoff as representative
    const cutoff = this.strategies[0]?.config.schedule.tradingCutoff || "11:30";
    await discord.sendMarketOpenSummary(
      timeUtils.getTodayDateString(),
      allSymbols.length,
      allSymbols,
      this.strategies[0]?.config.maxTradesPerDay || 2,
      cutoff,
    );
  }

  // main monitoring loop - polls candles and feeds them to strategies
  private async monitoringLoop(): Promise<void> {
    this.currentStatus = "Monitoring for signals";
    logger.normal("Starting main monitoring loop...");

    while (!this.isMarketClosing() && !this.stopRequested) {
      try {
        // process each strategy
        for (const entry of this.strategies) {
          // check cutoff time for this strategy
          const currentTime = timeUtils.formatTimeEST(new Date(), "HH:mm");
          const isPastCutoff = currentTime >= entry.config.schedule.tradingCutoff;

          // process each symbol
          for (const symbol of entry.config.symbols) {
            const key = this.trackingKey(entry.config.id, symbol);
            const track = this.tracking.get(key)!;

            // skip if done for the day
            if (track.done) continue;

            // skip new entries if past cutoff (but still monitor positions)
            if (isPastCutoff && !track.position) {
              track.done = true;
              continue;
            }

            // fetch latest 1-min candle
            const today = timeUtils.getTodayDateString();
            const candles = await alpacaData.fetch1MinCandles(symbol, today);
            if (candles.length === 0) continue;

            // use the most recent candle
            const candle = candles[candles.length - 1];

            // check for stale data (candle too old to be useful)
            const now = new Date();
            const ageMinutes = (now.getTime() - candle.timestamp.getTime()) / 60000;
            if (ageMinutes > entry.config.schedule.maxStaleDataMinutes) {
              logger.debug(`Stale data for ${symbol}: ${ageMinutes.toFixed(1)} min old`);
              continue;
            }

            // skip duplicate candles (same timestamp as last processed)
            if (track.lastCandleTimestamp && candle.timestamp.getTime() === track.lastCandleTimestamp.getTime()) {
              continue;
            }
            track.lastCandleTimestamp = candle.timestamp;

            // process this candle through the strategy
            await this.processSymbolCandle(entry, symbol, candle, track);
          }
        }
      } catch (error) {
        logger.error("Error in monitoring loop", error as Error);
        await discord.sendError("Monitoring loop error", (error as Error).message);
      }

      // wait before next poll (use shortest interval across strategies)
      const interval = this.getMinPollingInterval();
      await this.sleep(interval);
    }

    logger.normal("Market closing - ending monitoring loop");
  }

  // process a single candle for a symbol in a strategy
  private async processSymbolCandle(
    entry: StrategyEntry,
    symbol: string,
    candle: any,
    track: SymbolTracking,
  ): Promise<void> {

    // STEP 1: if we have an open position, evaluate it first
    if (track.position) {
      const update = entry.strategy.evaluatePosition(symbol, candle, track.position);
      await this.handlePositionUpdate(entry, symbol, candle, track, update);
      return; // don't look for new signals while in a position
    }

    // STEP 2: if no position, process candle for signals
    if (track.tradeExecutedToday) return; // already traded today

    // get account equity for sizing
    const accountInfo = this.globalConfig.mode === "PAPER"
      ? paperBroker.getAccountInfo()
      : { equity: 100000 };

    // ask strategy what to do with this candle
    const action = entry.strategy.onCandle(symbol, candle, accountInfo.equity);

    // handle the strategy's decision
    if (action.type === "ENTRY" && action.positionSize && action.signal) {
      await this.handleSignal(entry, symbol, action.signal, action.positionSize, track);
    } else if (action.type === "DONE") {
      track.done = true;
      if (action.reason) {
        state.logRejection(symbol, "FVG_PATTERN", action.reason);
      }
    }
  }

  // handle a trading signal - execute the trade with provided position size
  private async handleSignal(
    entry: StrategyEntry,
    symbol: string,
    signal: any,
    posSize: any,
    track: SymbolTracking,
  ): Promise<void> {
    const emoji = signal.direction === "LONG" ? "⬆️" : "⬇️";
    logger.normal(`${emoji} SIGNAL: ${signal.direction} ${symbol} | ${signal.reason}`);

    // execute the trade via broker
    let position: Position | null = null;
    if (this.globalConfig.mode === "PAPER") {
      position = paperBroker.openPosition(posSize);
    } else {
      logger.error("LIVE mode not yet implemented");
      return;
    }

    if (!position) {
      logger.error(`Failed to open position for ${symbol}`);
      await discord.sendError(`Failed to open position for ${symbol}`);
      return;
    }

    // update tracking state
    track.position = position;
    track.tradeExecutedToday = true;
    state.saveCurrentPosition(position);
    state.markTradeExecuted(symbol);

    // send discord notification to this strategy's trades channel
    await discord.sendTradeEntry(
      symbol,
      signal.direction,
      posSize.entryPrice,
      posSize.quantity,
      posSize.stopPrice,
      posSize.targetPrice,
      posSize.totalRisk,
      posSize.potentialProfit,
      entry.channels.trades,
    );

    logger.normal(`🟢 TRADE ENTRY: ${signal.direction} ${posSize.quantity} shares of ${symbol} @ $${posSize.entryPrice.toFixed(2)}`);
  }

  // handle a position update from the strategy
  private async handlePositionUpdate(
    entry: StrategyEntry,
    symbol: string,
    candle: any,
    track: SymbolTracking,
    update: any,
  ): Promise<void> {
    const position = track.position!;

    // 1. execute partial exit if requested
    if (update.doPartialExit && this.globalConfig.mode === "PAPER") {
      paperBroker.executePartialExit(position, update.partialExitPrice, update.partialExitPercent);
      state.saveCurrentPosition(position);
    }

    // 2. activate trailing stop if requested
    if (update.activateTrailing && this.globalConfig.mode === "PAPER") {
      paperBroker.activateTrailingStop(position);
      state.saveCurrentPosition(position);
    }

    // 3. update stop loss if trailing moved it
    if (update.newStopLoss !== null) {
      position.stopLoss = update.newStopLoss;
      // update highest/lowest price tracking for trailing stops
      if (position.side === "LONG") {
        position.highestPrice = Math.max(candle.high, position.highestPrice || position.entryPrice);
      } else {
        position.lowestPrice = Math.min(candle.low, position.lowestPrice || position.entryPrice);
      }
      state.saveCurrentPosition(position);
    }

    // 4. close position if requested
    if (update.closePosition) {
      // close via broker
      if (this.globalConfig.mode === "PAPER") {
        paperBroker.closePosition(symbol, update.closePrice, update.closeReason);
      }

      // calculate P&L
      let pnl: number;
      if (position.side === "LONG") {
        pnl = (update.closePrice - position.entryPrice) * position.quantity;
      } else {
        pnl = (position.entryPrice - update.closePrice) * position.quantity;
      }

      // create trade record for history
      const trade = {
        id: `TRADE-${Date.now()}`,
        symbol,
        side: position.side,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        quantity: position.originalQuantity,
        exitTime: new Date(),
        exitPrice: update.closePrice,
        exitReason: update.closeReason as any,
        pnl,
        pnlPercent: (pnl / (position.entryPrice * position.originalQuantity)) * 100,
        fees: 0,
        holdingTime: Math.floor((Date.now() - position.entryTime.getTime()) / 1000),
      };

      // persist trade and update stats
      state.saveTradeToHistory(trade);
      state.updateStatistics(trade);
      state.deleteCurrentPosition(symbol);

      // update tracking
      track.position = null;
      track.done = true;

      // send discord to this strategy's trades channel
      const duration = `${Math.floor(trade.holdingTime / 60)} minutes`;
      await discord.sendTradeExit(symbol, update.closePrice, pnl, trade.pnlPercent, update.closeReason, duration, entry.channels.trades);

      const pnlSign = pnl >= 0 ? "+" : "";
      logger.normal(`Position closed for ${symbol}: ${update.closeReason} | P&L: ${pnlSign}$${pnl.toFixed(2)}`);
    }
  }

  // end of day shutdown
  private async shutdown(): Promise<void> {
    logger.separator();
    logger.normal("Performing end-of-day shutdown...");

    // call onSessionEnd for each strategy
    for (const entry of this.strategies) {
      entry.strategy.onSessionEnd();
    }

    // close remaining positions (skip strategies that hold overnight)
    for (const [_key, track] of this.tracking) {
      if (track.position) {
        // find the strategy that owns this tracking entry
        const ownerEntry = this.strategies.find(e => e.config.id === track.strategyId);
        // skip closing if this strategy holds positions overnight
        if (ownerEntry && ownerEntry.strategy.holdOvernight) continue;

        logger.normal(`Closing end-of-day position for ${track.symbol}`);
        const today = timeUtils.getTodayDateString();
        const candles = await alpacaData.fetch1MinCandles(track.symbol, today);
        const currentPrice = candles.length > 0
          ? candles[candles.length - 1].close
          : track.position.entryPrice;

        if (this.globalConfig.mode === "PAPER") {
          paperBroker.closePositionManual(track.symbol, currentPrice);
        }

        state.deleteCurrentPosition(track.symbol);
        track.position = null;
      }
    }

    // load final stats for daily summary
    const stats = state.loadAllTimeStats();
    const accountBalance = this.globalConfig.mode === "PAPER"
      ? paperBroker.getAccountInfo().equity
      : 0;

    // find best/worst trades today
    const todayHistory = state.loadTradeHistory(timeUtils.getTodayDateString());
    let bestPnL: number | null = null;
    let worstPnL: number | null = null;
    if (todayHistory && todayHistory.trades.length > 0) {
      const pnls = todayHistory.trades.map((t) => t.pnl);
      bestPnL = Math.max(...pnls);
      worstPnL = Math.min(...pnls);
    }

    // log rejections for the day
    const rejections = state.getRejectionSummary(timeUtils.getTodayDateString());
    logger.normal(`Rejection summary: ${rejections.total} total`);
    if (rejections.total > 0) {
      logger.normal(`  By stage: ${JSON.stringify(rejections.byStage)}`);
      logger.normal(`  By symbol: ${JSON.stringify(rejections.bySymbol)}`);
    }

    // format streak for daily summary
    const streak = {
      type: stats.allTimeStats.currentStreak.type === "WIN"
        ? "win" as const
        : stats.allTimeStats.currentStreak.type === "LOSS"
          ? "loss" as const
          : "none" as const,
      count: stats.allTimeStats.currentStreak.count,
    };

    // send daily summary to discord
    await discord.sendDailySummary(
      timeUtils.getTodayDateString(),
      this.getAllSymbols(),
      stats.allTimeStats.totalTrades,
      stats.allTimeStats.wins,
      stats.allTimeStats.losses,
      stats.allTimeStats.totalPnL,
      accountBalance,
      bestPnL,
      worstPnL,
      streak,
    );

    logger.normal("🌙 SignalFlow Shutdown | End of trading day");
    logger.separator();
  }

  //============================================================================
  // HELPERS
  //============================================================================

  // create a strategy instance from config type
  // add new strategy types here (e.g. "mean-reversion", "vwap-bounce")
  private createStrategy(stratConfig: StrategyConfig): IStrategy {
    switch (stratConfig.type) {
      case "opening-range-breakout":
        return new ORBStrategy(stratConfig, this.globalConfig);
      default:
        throw new Error(`Unknown strategy type: ${stratConfig.type}. Register new types in createStrategy().`);
    }
  }

  // build a tracking map key from strategy id and symbol
  private trackingKey(strategyId: string, symbol: string): string {
    return `${strategyId}:${symbol}`;
  }

  // get all unique symbols across all strategies
  private getAllSymbols(): string[] {
    const symbolSet = new Set<string>();
    for (const entry of this.strategies) {
      for (const symbol of entry.config.symbols) {
        symbolSet.add(symbol);
      }
    }
    return Array.from(symbolSet);
  }

  // check if market is closing
  private isMarketClosing(): boolean {
    const currentTime = timeUtils.formatTimeEST(new Date(), "HH:mm");
    // use the first strategy's market close time (they should all be the same)
    const closeTime = this.strategies[0]?.config.schedule.marketClose || "16:00";
    return currentTime >= closeTime;
  }

  // get the shortest polling interval across all strategies
  private getMinPollingInterval(): number {
    let min = 10000; // default 10s
    for (const entry of this.strategies) {
      if (entry.config.schedule.pollingIntervalMs < min) {
        min = entry.config.schedule.pollingIntervalMs;
      }
    }
    return min;
  }

  // wait until a specific time (HH:mm EST)
  private async waitUntilTime(targetTime: string): Promise<void> {
    while (true) {
      const nowEST = timeUtils.getCurrentEstTime();
      const currentTime = timeUtils.formatTimeEST(nowEST, "HH:mm");
      if (currentTime >= targetTime) return;
      logger.debug(`Waiting for ${targetTime} EST (current: ${currentTime} EST)`);
      await this.sleep(30000);
    }
  }

  // resolve notification config env var names to actual channel IDs
  // falls back to global config if env var not found
  private resolveChannels(stratConfig: StrategyConfig): ResolvedChannels {
    const notifications = stratConfig.notifications;
    return {
      trades: process.env[notifications.trades] || this.globalConfig.discordChannelTrades,
      system: process.env[notifications.system] || this.globalConfig.discordChannelSystem,
      errors: process.env[notifications.errors] || this.globalConfig.discordChannelErrors,
    };
  }

  // stop the runner gracefully (called by /restart command)
  stop(): void {
    this.stopRequested = true;
    this.currentStatus = "Stopped";
    logger.normal("Stop requested");
  }

  // get current status (called by /status command)
  getStatus(): string {
    return this.currentStatus;
  }

  // sleep helper
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
