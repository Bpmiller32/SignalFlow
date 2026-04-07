// orbStrategy.ts - Opening Range Breakout + FVG Confirmation strategy
// Implements IStrategy interface. This is a pure decision-maker.
// Does NOT execute trades or send notifications. The StrategyRunner does that.
//
// Strategy logic:
// 1. At session start, fetches 5-min opening candle and evaluates the opening range
// 2. During monitoring, looks for a breakout above/below the opening range
// 3. After breakout, collects 3 candles and checks for FVG (Fair Value Gap) pattern
// 4. If FVG confirmed, generates entry signal with position sizing
// 5. Manages open positions with trailing stops and partial exits

import { IStrategy } from "./IStrategy";
import {
  Candle,
  Signal,
  FVGPattern,
  Position,
  PositionSize,
  OpeningRange,
  Config,
  StrategyConfig,
  StrategyAction,
  PositionUpdate,
  OpeningRangeResult,
  CandleResult,
  ORFilterConfig,
  BreakoutConfig,
  FVGConfig,
  PositionSizingConfig,
  RiskManagementConfig,
} from "../types";
import * as alpacaData from "../alpacaData";
import * as strategy from "../strategy";
import * as filters from "../filters";
import * as positionSizer from "../positionSizer";
import * as logger from "../logger";
import * as fs from "fs";
import * as path from "path";

// ORB-specific parameters extracted from config.params
// these map to the "params" object in strategies.json
interface ORBParams {
  openingRange: ORFilterConfig;
  breakout: BreakoutConfig;
  fvg: FVGConfig;
  positionSizing: PositionSizingConfig;
  riskManagement: RiskManagementConfig;
}

// internal state tracked per symbol during a trading session
interface ORBSymbolState {
  openingRange: OpeningRange | null; // the calculated opening range
  openingRangeCandle: Candle | null; // the 5-min candle used for OR
  openingRangeAvgVolume: number; // avg volume per minute from OR candle
  openingRangeStrength: number; // strength score 0-10
  breakoutDetected: boolean; // has a breakout been detected
  breakoutCandleWindow: Candle[]; // 3-candle FVG window [breakout, momentum, gap]
  breakoutTimestamp: Date | null; // when breakout was first detected
  recentCandlesBuffer: Candle[]; // rolling buffer of last 20 candles for ATR
  done: boolean; // true when done trading this symbol today
}

export class ORBStrategy implements IStrategy {
  // IStrategy properties
  readonly name: string;
  readonly type: string = "opening-range-breakout";
  readonly holdOvernight: boolean = false; // ORB is a day-trade strategy

  // strategy config from strategies.json (generic fields like id, symbols, schedule)
  private config: StrategyConfig;

  // ORB-specific params extracted from config.params
  private orbParams: ORBParams;

  // global config from .env (needed for legacy pure function compatibility)
  private globalConfig: Config;

  // per-symbol internal state
  private symbolStates: Map<string, ORBSymbolState>;

  // cached Config-shaped object for calling existing pure functions
  private legacyConfig: Config;

  constructor(config: StrategyConfig, globalConfig: Config) {
    this.name = config.id;
    this.config = config;
    // extract ORB-specific params from the generic params object
    this.orbParams = config.params as ORBParams;
    this.globalConfig = globalConfig;
    this.symbolStates = new Map();
    // build a Config-shaped object so legacy pure functions work unchanged
    this.legacyConfig = this.buildLegacyConfig();
  }

  // set up internal state for each symbol
  initialize(symbols: string[]): void {
    for (const symbol of symbols) {
      this.symbolStates.set(symbol, {
        openingRange: null,
        openingRangeCandle: null,
        openingRangeAvgVolume: 0,
        openingRangeStrength: 0,
        breakoutDetected: false,
        breakoutCandleWindow: [],
        breakoutTimestamp: null,
        recentCandlesBuffer: [],
        done: false,
      });
    }
    logger.normal(`ORBStrategy [${this.name}] initialized for ${symbols.length} symbols`);
  }

  // called at session start - fetches opening range data for all symbols
  // date param allows backtester to pass historical dates
  async onSessionStart(date: string): Promise<void> {
    for (const symbol of this.config.symbols) {
      try {
        // fetch the 5-min opening range candle for this date
        const candles5min = await alpacaData.fetch5MinCandles(symbol, date);
        if (candles5min.length === 0) {
          logger.normal(`No opening range data for ${symbol} on ${date}`);
          this.getState(symbol).done = true;
          continue;
        }

        // fetch previous day close for gap detection
        let prevClose: number | null = null;
        try {
          const dailyCandles = await alpacaData.fetchDailyCandles(symbol, 2);
          if (dailyCandles.length >= 1) {
            prevClose = dailyCandles[dailyCandles.length - 1].close;
          }
        } catch (_e) {
          // skip gap check if previous close unavailable
        }

        // evaluate the opening range using internal method
        const result = this.evaluateOpeningRange(symbol, candles5min[0], prevClose);
        if (result.accepted) {
          logger.normal(`📊 OPENING RANGE: ${symbol} | High: $${result.openingRange!.high.toFixed(2)} | Low: $${result.openingRange!.low.toFixed(2)}`);
        } else {
          logger.normal(`Skipping ${symbol}: ${result.rejectReason}`);
        }
      } catch (error) {
        logger.error(`Failed opening range for ${symbol}`, error as Error);
        this.getState(symbol).done = true;
      }
    }
  }

  // called on each 1-min candle - runs the full ORB pipeline and returns a decision
  onCandle(symbol: string, candle: Candle, accountEquity: number): StrategyAction {
    // process the candle through breakout detection and FVG confirmation
    const result = this.processCandle(symbol, candle);

    // no signal - return none or done
    if (!result.signal || !result.fvgPattern) {
      return {
        type: result.done ? "DONE" : "NONE",
        positionSize: null,
        signal: null,
        reason: result.rejectReason,
      };
    }

    // signal generated - calculate position size
    const symbolState = this.getState(symbol);
    const posSize = this.calculatePositionSize(
      symbol, result.signal, symbolState.openingRange!, result.fvgPattern, accountEquity,
    );

    // sizing failed - done for this symbol
    if (!posSize) {
      return { type: "DONE", positionSize: null, signal: null, reason: "sizing failed" };
    }

    // return entry action with everything the runner needs to execute
    return {
      type: "ENTRY",
      positionSize: posSize,
      signal: result.signal,
      reason: result.signal.reason,
    };
  }

  // evaluate what to do with an open position on this candle
  evaluatePosition(symbol: string, candle: Candle, position: Position): PositionUpdate {
    // start with a no-op update (no changes)
    const result: PositionUpdate = {
      doPartialExit: false,
      partialExitPrice: 0,
      partialExitPercent: 0,
      activateTrailing: false,
      newStopLoss: null,
      closePosition: false,
      closePrice: 0,
      closeReason: "",
    };

    const rm = this.orbParams.riskManagement;

    // 1. check if partial exit should trigger
    if (rm.usePartialExits && !position.partialExitExecuted) {
      // calculate how far price needs to move for partial exit (in R-multiples)
      const initialRisk = Math.abs(position.entryPrice - position.initialStopLoss);
      const targetProfit = initialRisk * rm.partialExitAtRMultiple;

      // check if price has reached the partial exit threshold
      let triggered = false;
      if (position.side === "LONG") {
        triggered = candle.close >= position.entryPrice + targetProfit;
      } else {
        triggered = candle.close <= position.entryPrice - targetProfit;
      }

      if (triggered) {
        result.doPartialExit = true;
        result.partialExitPrice = candle.close;
        result.partialExitPercent = rm.partialExitPercent;
        // activate trailing stop after taking partial profits
        if (rm.useTrailingStops) {
          result.activateTrailing = true;
        }
      }
    }

    // 2. update trailing stop if active
    let effectiveStop = position.stopLoss;
    if (rm.useTrailingStops && (position.trailingStopActive || result.activateTrailing)) {
      // calculate trailing distance from ATR or use 1% fallback
      const symbolState = this.symbolStates.get(symbol);
      let trailingDistance: number;
      if (rm.useAtrStops && symbolState && symbolState.recentCandlesBuffer.length > rm.atrPeriod + 1) {
        const atr = positionSizer.calculateATR(symbolState.recentCandlesBuffer, rm.atrPeriod);
        trailingDistance = atr * rm.trailingStopAtrMultiple;
      } else {
        // fallback: 1% of price
        trailingDistance = candle.close * 0.01;
      }

      // compute new trailing stop value
      if (position.side === "LONG") {
        const highest = Math.max(candle.high, position.highestPrice || position.entryPrice);
        const newStop = highest - trailingDistance;
        // only move stop up, never down
        if (newStop > effectiveStop) {
          effectiveStop = newStop;
          result.newStopLoss = newStop;
        }
      } else {
        const lowest = Math.min(candle.low, position.lowestPrice || position.entryPrice);
        const newStop = lowest + trailingDistance;
        // only move stop down, never up
        if (newStop < effectiveStop) {
          effectiveStop = newStop;
          result.newStopLoss = newStop;
        }
      }
    }

    // 3. check stop loss and take profit against effective stop
    if (position.side === "LONG") {
      if (candle.low <= effectiveStop) {
        result.closePosition = true;
        result.closePrice = effectiveStop;
        result.closeReason = "STOP_LOSS";
      } else if (candle.high >= position.takeProfit) {
        result.closePosition = true;
        result.closePrice = position.takeProfit;
        result.closeReason = "TAKE_PROFIT";
      }
    } else {
      if (candle.high >= effectiveStop) {
        result.closePosition = true;
        result.closePrice = effectiveStop;
        result.closeReason = "STOP_LOSS";
      } else if (candle.low <= position.takeProfit) {
        result.closePosition = true;
        result.closePrice = position.takeProfit;
        result.closeReason = "TAKE_PROFIT";
      }
    }

    return result;
  }

  // called at market close - resets all symbol state for next day
  onSessionEnd(): void {
    for (const symbol of this.config.symbols) {
      this.reset(symbol);
    }
  }

  // return the strategy config
  getConfig(): StrategyConfig {
    return this.config;
  }

  //============================================================================
  // INTERNAL ORB LOGIC (private helpers called by the interface methods above)
  //============================================================================

  // evaluate the opening range candle - returns accept/reject with details
  private evaluateOpeningRange(
    symbol: string,
    candle: Candle,
    previousDayClose: number | null,
  ): OpeningRangeResult {
    const symbolState = this.getState(symbol);
    const orConfig = this.orbParams.openingRange;

    // calculate the opening range from the 5-min candle
    const openingRange = strategy.calculateOpeningRange(candle);

    // check pre-market gap filter
    if (previousDayClose !== null) {
      const gapPercent = strategy.calculatePreMarketGap(candle, previousDayClose);
      if (strategy.isPreMarketGapTooLarge(gapPercent, orConfig.maxPremarketGap)) {
        const reason = `Pre-market gap ${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}% exceeds ${orConfig.maxPremarketGap}% limit`;
        symbolState.done = true;
        return { accepted: false, openingRange: null, rejectReason: reason, strength: 0 };
      }
    }

    // check earnings calendar
    if (orConfig.skipEarningsDays) {
      const earningsReason = this.checkEarningsCalendar(symbol);
      if (earningsReason) {
        symbolState.done = true;
        return { accepted: false, openingRange: null, rejectReason: earningsReason, strength: 0 };
      }
    }

    // check range size validity using legacy config
    const isValid = strategy.isOpeningRangeValid(openingRange, candle.close, this.legacyConfig);
    if (!isValid) {
      const reason = `Range size ${openingRange.size.toFixed(2)}% outside ${orConfig.minSize}%-${orConfig.maxSize}% limits`;
      symbolState.done = true;
      return { accepted: false, openingRange: null, rejectReason: reason, strength: 0 };
    }

    // score opening range strength
    const strength = strategy.scoreOpeningRangeStrength(openingRange, candle, this.legacyConfig);
    if (strength < orConfig.minStrength) {
      const reason = `Strength ${strength.toFixed(1)}/10 below minimum ${orConfig.minStrength}`;
      symbolState.done = true;
      return { accepted: false, openingRange: null, rejectReason: reason, strength };
    }

    // log the filter scorecard for debugging
    this.logFilterScorecard(symbol, candle, previousDayClose, openingRange, strength);

    // all filters passed - save state and accept
    symbolState.openingRange = openingRange;
    symbolState.openingRangeCandle = candle;
    symbolState.openingRangeAvgVolume = strategy.calculateOpeningRangeAvgVolume(candle);
    symbolState.openingRangeStrength = strength;

    return { accepted: true, openingRange, rejectReason: "", strength };
  }

  // process a 1-min candle during monitoring phase
  // goes through breakout detection → FVG window collection → FVG pattern check
  private processCandle(symbol: string, candle: Candle): CandleResult {
    const symbolState = this.getState(symbol);
    const breakoutConfig = this.orbParams.breakout;

    // already done for the day
    if (symbolState.done) {
      return { signal: null, fvgPattern: null, done: true, rejectReason: "done for day" };
    }

    // need an opening range to proceed
    if (!symbolState.openingRange || !symbolState.openingRangeCandle) {
      return { signal: null, fvgPattern: null, done: false, rejectReason: "no opening range" };
    }

    // check minimum absolute volume
    if (candle.volume < breakoutConfig.minAbsoluteVolume) {
      return { signal: null, fvgPattern: null, done: false, rejectReason: "volume below minimum" };
    }

    // add candle to rolling buffer for ATR calculation (keep last 20)
    symbolState.recentCandlesBuffer.push(candle);
    if (symbolState.recentCandlesBuffer.length > 20) {
      symbolState.recentCandlesBuffer.shift();
    }

    // PHASE 1: no breakout yet - look for one
    if (!symbolState.breakoutDetected) {
      return this.checkForBreakout(symbol, candle, symbolState);
    }

    // PHASE 2: breakout detected - collecting FVG window candles

    // check if breakout has gone stale (too much time passed)
    if (symbolState.breakoutTimestamp) {
      const minutesSince = (candle.timestamp.getTime() - symbolState.breakoutTimestamp.getTime()) / 60000;
      if (minutesSince > breakoutConfig.maxFvgWindowMinutes) {
        logger.normal(`Stale breakout for ${symbol}: ${minutesSince.toFixed(1)} min (max: ${breakoutConfig.maxFvgWindowMinutes})`);
        symbolState.done = true;
        return { signal: null, fvgPattern: null, done: true, rejectReason: "breakout went stale" };
      }
    }

    // add candle to FVG window (need 3 candles total)
    if (symbolState.breakoutCandleWindow.length < 3) {
      symbolState.breakoutCandleWindow.push(candle);
      if (symbolState.breakoutCandleWindow.length < 3) {
        return { signal: null, fvgPattern: null, done: false, rejectReason: "collecting FVG candles" };
      }
    }

    // PHASE 3: have 3 candles - check for FVG pattern
    return this.checkFVGPattern(symbol, candle, symbolState);
  }

  // calculate position sizing for a confirmed signal
  private calculatePositionSize(
    symbol: string,
    signal: Signal,
    openingRange: OpeningRange,
    fvgPattern: FVGPattern,
    accountEquity: number,
  ): PositionSize | null {
    const symbolState = this.getState(symbol);
    const sizingConfig = this.orbParams.positionSizing;
    const riskConfig = this.orbParams.riskManagement;

    // grade signal quality for adaptive sizing
    let signalQuality: "STRONG" | "WEAK" = "STRONG";
    if (sizingConfig.useAdaptive) {
      signalQuality = filters.gradeSignalQuality(fvgPattern, this.legacyConfig);
    }

    // calculate base position size using existing pure functions
    const recentCandles = symbolState.recentCandlesBuffer.length >= riskConfig.atrPeriod + 1
      ? symbolState.recentCandlesBuffer
      : [];

    let posSize = positionSizer.calculatePositionSize(
      signal, openingRange, accountEquity, this.legacyConfig, recentCandles,
    );

    if (!posSize) {
      logger.normal(`Cannot size position for ${symbol} - skipping`);
      return null;
    }

    // apply opening range strength adjustment (weaker ranges get smaller positions)
    const strengthMultiplier = filters.adjustSizeForOpeningRangeStrength(symbolState.openingRangeStrength);
    if (strengthMultiplier === 0) {
      logger.normal(`Trade rejected for ${symbol}: OR strength too low`);
      return null;
    }
    if (strengthMultiplier < 1.0) {
      const origQty = posSize.quantity;
      posSize.quantity = Math.floor(posSize.quantity * strengthMultiplier);
      posSize.dollarValue = posSize.quantity * posSize.entryPrice;
      posSize.totalRisk = posSize.quantity * posSize.riskPerShare;
      posSize.potentialProfit = posSize.quantity * (posSize.targetPrice - posSize.entryPrice);
      logger.normal(`OR strength adjustment: ${origQty} → ${posSize.quantity} shares (${(strengthMultiplier * 100).toFixed(0)}%)`);
    }

    // apply weak signal size reduction
    if (signalQuality === "WEAK" && sizingConfig.useAdaptive) {
      const factor = sizingConfig.weakSignalSizePercent / 100;
      const origQty = posSize.quantity;
      posSize.quantity = Math.floor(posSize.quantity * factor);
      posSize.dollarValue = posSize.quantity * posSize.entryPrice;
      posSize.totalRisk = posSize.quantity * posSize.riskPerShare;
      posSize.potentialProfit = posSize.quantity * (posSize.targetPrice - posSize.entryPrice);
      logger.normal(`Weak signal adjustment: ${origQty} → ${posSize.quantity} shares (${sizingConfig.weakSignalSizePercent}%)`);
    }

    // final quantity check
    if (posSize.quantity < 1) {
      logger.normal(`Position too small after adjustments for ${symbol}`);
      return null;
    }

    // validate position against min/max limits
    if (!positionSizer.validatePositionSize(posSize, this.legacyConfig)) {
      logger.normal(`Position validation failed for ${symbol}`);
      return null;
    }

    return posSize;
  }

  // reset internal state for a symbol (end of day cleanup)
  private reset(symbol: string): void {
    this.symbolStates.set(symbol, {
      openingRange: null,
      openingRangeCandle: null,
      openingRangeAvgVolume: 0,
      openingRangeStrength: 0,
      breakoutDetected: false,
      breakoutCandleWindow: [],
      breakoutTimestamp: null,
      recentCandlesBuffer: [],
      done: false,
    });
  }

  //============================================================================
  // PRIVATE HELPERS
  //============================================================================

  // get internal state for a symbol, throws if not initialized
  private getState(symbol: string): ORBSymbolState {
    const symbolState = this.symbolStates.get(symbol);
    if (!symbolState) {
      throw new Error(`ORBStrategy: symbol ${symbol} not initialized`);
    }
    return symbolState;
  }

  // check for breakout on a candle (called when no breakout detected yet)
  private checkForBreakout(symbol: string, candle: Candle, symbolState: ORBSymbolState): CandleResult {
    // use the pure function to detect breakout above/below the opening range
    const breakout = strategy.detectBreakout(candle, symbolState.openingRange!, symbolState.openingRangeAvgVolume);

    if (!breakout.detected) {
      return { signal: null, fvgPattern: null, done: false, rejectReason: "no breakout" };
    }

    // breakout found - start collecting FVG window candles
    logger.normal(`Breakout detected for ${symbol}: ${breakout.direction}`);
    symbolState.breakoutDetected = true;
    symbolState.breakoutTimestamp = candle.timestamp;
    symbolState.breakoutCandleWindow = [candle];

    return { signal: null, fvgPattern: null, done: false, rejectReason: "breakout detected, waiting for FVG" };
  }

  // check FVG pattern with the 3 collected candles
  private checkFVGPattern(symbol: string, candle: Candle, symbolState: ORBSymbolState): CandleResult {
    // determine direction from price relative to opening range
    const direction = candle.close > symbolState.openingRange!.high ? "BULLISH" : "BEARISH";

    // check FVG using the pure function
    const fvgPattern = strategy.detectFVG(
      symbolState.breakoutCandleWindow, direction, this.legacyConfig, symbolState.openingRangeAvgVolume,
    );

    if (!fvgPattern.detected) {
      // FVG not confirmed - done for this symbol today
      logger.normal(`FVG not confirmed for ${symbol}`);
      symbolState.done = true;
      return { signal: null, fvgPattern: null, done: true, rejectReason: fvgPattern.details || "FVG not met" };
    }

    // FVG confirmed - generate trading signal
    const breakoutResult = {
      detected: true as const,
      direction: (direction === "BULLISH" ? "ABOVE" : "BELOW") as "ABOVE" | "BELOW",
      candle,
      openingRange: symbolState.openingRange!,
    };

    const signal = strategy.generateSignal(symbol, breakoutResult, fvgPattern, candle.close);
    if (!signal) {
      symbolState.done = true;
      return { signal: null, fvgPattern: null, done: true, rejectReason: "signal generation failed" };
    }

    // signal generated successfully - mark done (one trade per symbol per day)
    symbolState.done = true;
    return { signal, fvgPattern, done: true, rejectReason: "" };
  }

  // check if today is an earnings day for the symbol
  private checkEarningsCalendar(symbol: string): string | null {
    try {
      const earningsPath = path.join(process.cwd(), "data", "earnings-calendar.json");
      if (!fs.existsSync(earningsPath)) {
        return null; // no calendar file, skip check
      }
      const calendar = JSON.parse(fs.readFileSync(earningsPath, "utf8"));
      const earningsDates = calendar[symbol] || [];
      // get today's date string
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const today = `${year}-${month}-${day}`;

      if (earningsDates.includes(today)) {
        return "Earnings announcement today - avoiding unpredictable volatility";
      }
      return null;
    } catch (error) {
      logger.debug(`Could not load earnings calendar: ${(error as Error).message}`);
      return null;
    }
  }

  // log the opening range filter scorecard for debugging
  private logFilterScorecard(
    symbol: string,
    candle: Candle,
    previousDayClose: number | null,
    openingRange: OpeningRange,
    strength: number,
  ): void {
    const orConfig = this.orbParams.openingRange;
    logger.normal(`\n${"═".repeat(60)}`);
    logger.normal(`FILTER SCORECARD - ${symbol} Opening Range Analysis`);
    logger.normal(`${"═".repeat(60)}`);

    // gap filter result
    if (previousDayClose !== null) {
      const gap = strategy.calculatePreMarketGap(candle, previousDayClose);
      const passed = Math.abs(gap) <= orConfig.maxPremarketGap;
      logger.normal(`${passed ? "✅" : "❌"} Gap: ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% (limit: ${orConfig.maxPremarketGap}%)`);
    } else {
      logger.normal(`⚪ Gap: Not checked (no prev close)`);
    }

    // range size result
    const minPassed = openingRange.size >= orConfig.minSize;
    logger.normal(`${minPassed ? "✅" : "❌"} Min Size: ${openingRange.size.toFixed(2)}% (need ${orConfig.minSize}%)`);
    const maxPassed = openingRange.size <= orConfig.maxSize;
    logger.normal(`${maxPassed ? "✅" : "❌"} Max Size: ${openingRange.size.toFixed(2)}% (max ${orConfig.maxSize}%)`);

    // strength result
    const strPassed = strength >= orConfig.minStrength;
    logger.normal(`${strPassed ? "✅" : "❌"} Strength: ${strength.toFixed(1)}/10 (need ${orConfig.minStrength})`);

    logger.normal(`${"═".repeat(60)}\n`);
  }

  // build a Config-compatible object from JSON config + global config
  // needed because existing pure functions (strategy.ts, positionSizer.ts, filters.ts) expect Config type
  private buildLegacyConfig(): Config {
    const p = this.orbParams;
    return {
      // global values from .env
      mode: this.globalConfig.mode,
      alpacaApiKey: this.globalConfig.alpacaApiKey,
      alpacaSecretKey: this.globalConfig.alpacaSecretKey,
      alpacaBaseUrl: this.globalConfig.alpacaBaseUrl,
      discordBotToken: this.globalConfig.discordBotToken,
      discordGuildId: this.globalConfig.discordGuildId,
      discordChannelTrades: this.globalConfig.discordChannelTrades,
      discordChannelSystem: this.globalConfig.discordChannelSystem,
      discordChannelErrors: this.globalConfig.discordChannelErrors,
      logLevel: this.globalConfig.logLevel,
      saveCandleData: this.globalConfig.saveCandleData,
      // strategy values from JSON params
      symbols: this.config.symbols,
      maxTradesPerDay: this.config.maxTradesPerDay,
      strategyCutoffTime: this.config.schedule.tradingCutoff,
      positionSizeMode: p.positionSizing.mode,
      fixedPositionSize: p.positionSizing.fixedSize,
      accountRiskPercent: p.positionSizing.accountRiskPercent,
      maxPositionValue: p.positionSizing.maxValue,
      minPositionValue: p.positionSizing.minValue,
      riskRewardRatio: p.riskManagement.riskRewardRatio,
      stopLossBufferPercent: p.riskManagement.stopLossBufferPercent,
      useAtrStops: p.riskManagement.useAtrStops,
      atrPeriod: p.riskManagement.atrPeriod,
      atrStopMultiplier: p.riskManagement.atrStopMultiplier,
      useTrailingStops: p.riskManagement.useTrailingStops,
      trailingStopActivation: p.riskManagement.trailingStopActivation,
      trailingStopAtrMultiple: p.riskManagement.trailingStopAtrMultiple,
      usePartialExits: p.riskManagement.usePartialExits,
      partialExitAtRMultiple: p.riskManagement.partialExitAtRMultiple,
      partialExitPercent: p.riskManagement.partialExitPercent,
      useAdaptivePositionSizing: p.positionSizing.useAdaptive,
      weakSignalSizePercent: p.positionSizing.weakSignalSizePercent,
      openingRangeMinSize: p.openingRange.minSize,
      openingRangeMaxSize: p.openingRange.maxSize,
      fvgBodyPercent: p.fvg.bodyPercent,
      fvgMinRangePercent: p.fvg.minRangePercent,
      fvgOverlapTolerance: p.fvg.overlapTolerance,
      fvgClosePositionPercent: p.fvg.closePositionPercent,
      requireVolumeConfirmation: p.fvg.requireVolumeConfirmation,
      volumeMultiplier: p.fvg.volumeMultiplier,
      skipEarningsDays: p.openingRange.skipEarningsDays,
      openingRangeMinStrength: p.openingRange.minStrength,
      minAbsoluteVolumePerMinute: p.breakout.minAbsoluteVolume,
      maxFvgWindowMinutes: p.breakout.maxFvgWindowMinutes,
      maxPremarketGapPercent: p.openingRange.maxPremarketGap,
    };
  }
}
