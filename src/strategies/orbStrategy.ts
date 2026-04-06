// orbStrategy.ts - Opening Range Breakout + FVG Confirmation strategy
// Extracted from the original main.ts monolith into a pluggable strategy class.
// This is the decision-maker. It does NOT execute trades or fetch data.
// The StrategyRunner calls these methods, gets decisions, and executes them.

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
  OpeningRangeResult,
  CandleResult,
  PositionUpdate,
} from "../types";
import * as strategy from "../strategy";
import * as filters from "../filters";
import * as positionSizer from "../positionSizer";
import * as logger from "../logger";
import * as fs from "fs";
import * as path from "path";

// internal state tracked per symbol
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
  // interface properties
  readonly name: string;
  readonly type: string = "opening-range-breakout";

  // config from JSON
  private config: StrategyConfig;

  // global config from .env (needed for legacy function compatibility)
  private globalConfig: Config;

  // per-symbol internal state
  private symbolStates: Map<string, ORBSymbolState>;

  // cached Config object for calling existing pure functions
  private legacyConfig: Config;

  constructor(config: StrategyConfig, globalConfig: Config) {
    this.name = config.id;
    this.config = config;
    this.globalConfig = globalConfig;
    this.symbolStates = new Map();
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

  // evaluate the opening range candle - returns accept/reject
  evaluateOpeningRange(
    symbol: string,
    candle: Candle,
    previousDayClose: number | null,
  ): OpeningRangeResult {
    const state = this.getState(symbol);
    const cfg = this.config;

    // calculate the opening range from the 5-min candle
    const openingRange = strategy.calculateOpeningRange(candle);

    // check pre-market gap
    if (previousDayClose !== null) {
      const gapPercent = strategy.calculatePreMarketGap(candle, previousDayClose);
      if (strategy.isPreMarketGapTooLarge(gapPercent, cfg.openingRange.maxPremarketGap)) {
        const reason = `Pre-market gap ${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}% exceeds ${cfg.openingRange.maxPremarketGap}% limit`;
        state.done = true;
        return { accepted: false, openingRange: null, rejectReason: reason, strength: 0 };
      }
    }

    // check earnings calendar
    if (cfg.openingRange.skipEarningsDays) {
      const earningsReason = this.checkEarningsCalendar(symbol);
      if (earningsReason) {
        state.done = true;
        return { accepted: false, openingRange: null, rejectReason: earningsReason, strength: 0 };
      }
    }

    // check range size validity
    const isValid = strategy.isOpeningRangeValid(openingRange, candle.close, this.legacyConfig);
    if (!isValid) {
      const reason = `Range size ${openingRange.size.toFixed(2)}% outside ${cfg.openingRange.minSize}%-${cfg.openingRange.maxSize}% limits`;
      state.done = true;
      return { accepted: false, openingRange: null, rejectReason: reason, strength: 0 };
    }

    // score opening range strength
    const strength = strategy.scoreOpeningRangeStrength(openingRange, candle, this.legacyConfig);
    if (strength < cfg.openingRange.minStrength) {
      const reason = `Strength ${strength.toFixed(1)}/10 below minimum ${cfg.openingRange.minStrength}`;
      state.done = true;
      return { accepted: false, openingRange: null, rejectReason: reason, strength };
    }

    // log the filter scorecard
    this.logFilterScorecard(symbol, candle, previousDayClose, openingRange, strength);

    // all filters passed - save state and accept
    state.openingRange = openingRange;
    state.openingRangeCandle = candle;
    state.openingRangeAvgVolume = strategy.calculateOpeningRangeAvgVolume(candle);
    state.openingRangeStrength = strength;

    return { accepted: true, openingRange, rejectReason: "", strength };
  }

  // process a 1-min candle during monitoring phase
  processCandle(symbol: string, candle: Candle): CandleResult {
    const state = this.getState(symbol);
    const cfg = this.config;

    // already done for the day
    if (state.done) {
      return { signal: null, fvgPattern: null, done: true, rejectReason: "done for day" };
    }

    // need an opening range to proceed
    if (!state.openingRange || !state.openingRangeCandle) {
      return { signal: null, fvgPattern: null, done: false, rejectReason: "no opening range" };
    }

    // check minimum absolute volume
    if (candle.volume < cfg.breakout.minAbsoluteVolume) {
      return { signal: null, fvgPattern: null, done: false, rejectReason: "volume below minimum" };
    }

    // add candle to rolling buffer for ATR (keep last 20)
    state.recentCandlesBuffer.push(candle);
    if (state.recentCandlesBuffer.length > 20) {
      state.recentCandlesBuffer.shift();
    }

    // PHASE 1: no breakout yet - look for one
    if (!state.breakoutDetected) {
      return this.checkForBreakout(symbol, candle, state);
    }

    // PHASE 2: breakout detected - collecting FVG window

    // check if breakout has gone stale
    if (state.breakoutTimestamp) {
      const minutesSince = (candle.timestamp.getTime() - state.breakoutTimestamp.getTime()) / 60000;
      if (minutesSince > cfg.breakout.maxFvgWindowMinutes) {
        logger.normal(`Stale breakout for ${symbol}: ${minutesSince.toFixed(1)} min (max: ${cfg.breakout.maxFvgWindowMinutes})`);
        state.done = true;
        return { signal: null, fvgPattern: null, done: true, rejectReason: "breakout went stale" };
      }
    }

    // add candle to FVG window
    if (state.breakoutCandleWindow.length < 3) {
      state.breakoutCandleWindow.push(candle);
      if (state.breakoutCandleWindow.length < 3) {
        return { signal: null, fvgPattern: null, done: false, rejectReason: "collecting FVG candles" };
      }
    }

    // PHASE 3: have 3 candles - check FVG pattern
    return this.checkFVGPattern(symbol, candle, state);
  }

  // calculate position sizing for a signal
  calculatePositionSize(
    symbol: string,
    signal: Signal,
    openingRange: OpeningRange,
    fvgPattern: FVGPattern,
    accountEquity: number,
  ): PositionSize | null {
    const state = this.getState(symbol);
    const cfg = this.config;

    // grade signal quality for adaptive sizing
    let signalQuality: "STRONG" | "WEAK" = "STRONG";
    if (cfg.positionSizing.useAdaptive) {
      signalQuality = filters.gradeSignalQuality(fvgPattern, this.legacyConfig);
    }

    // calculate base position size using existing pure functions
    const recentCandles = state.recentCandlesBuffer.length >= cfg.riskManagement.atrPeriod + 1
      ? state.recentCandlesBuffer
      : [];

    let posSize = positionSizer.calculatePositionSize(
      signal,
      openingRange,
      accountEquity,
      this.legacyConfig,
      recentCandles,
    );

    if (!posSize) {
      logger.normal(`Cannot size position for ${symbol} - skipping`);
      return null;
    }

    // apply opening range strength adjustment
    const strengthMultiplier = filters.adjustSizeForOpeningRangeStrength(state.openingRangeStrength);
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
    if (signalQuality === "WEAK" && cfg.positionSizing.useAdaptive) {
      const factor = cfg.positionSizing.weakSignalSizePercent / 100;
      const origQty = posSize.quantity;
      posSize.quantity = Math.floor(posSize.quantity * factor);
      posSize.dollarValue = posSize.quantity * posSize.entryPrice;
      posSize.totalRisk = posSize.quantity * posSize.riskPerShare;
      posSize.potentialProfit = posSize.quantity * (posSize.targetPrice - posSize.entryPrice);
      logger.normal(`Weak signal adjustment: ${origQty} → ${posSize.quantity} shares (${cfg.positionSizing.weakSignalSizePercent}%)`);
    }

    // final quantity check
    if (posSize.quantity < 1) {
      logger.normal(`Position too small after adjustments for ${symbol}`);
      return null;
    }

    // validate
    if (!positionSizer.validatePositionSize(posSize, this.legacyConfig)) {
      logger.normal(`Position validation failed for ${symbol}`);
      return null;
    }

    return posSize;
  }

  // evaluate what to do with an open position
  evaluatePosition(symbol: string, candle: Candle, position: Position): PositionUpdate {
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

    const rm = this.config.riskManagement;

    // 1. check partial exit trigger
    if (rm.usePartialExits && !position.partialExitExecuted) {
      const initialRisk = Math.abs(position.entryPrice - position.initialStopLoss);
      const targetProfit = initialRisk * rm.partialExitAtRMultiple;

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
        // activate trailing after partial exit
        if (rm.useTrailingStops) {
          result.activateTrailing = true;
        }
      }
    }

    // 2. update trailing stop if active
    let effectiveStop = position.stopLoss;
    if (rm.useTrailingStops && (position.trailingStopActive || result.activateTrailing)) {
      // calculate trailing distance
      const state = this.symbolStates.get(symbol);
      let trailingDistance: number;
      if (rm.useAtrStops && state && state.recentCandlesBuffer.length > rm.atrPeriod + 1) {
        const atr = positionSizer.calculateATR(state.recentCandlesBuffer, rm.atrPeriod);
        trailingDistance = atr * rm.trailingStopAtrMultiple;
      } else {
        trailingDistance = candle.close * 0.01; // 1% default fallback
      }

      // compute new trailing stop value
      if (position.side === "LONG") {
        const highest = Math.max(candle.high, position.highestPrice || position.entryPrice);
        const newStop = highest - trailingDistance;
        if (newStop > effectiveStop) {
          effectiveStop = newStop;
          result.newStopLoss = newStop;
        }
      } else {
        const lowest = Math.min(candle.low, position.lowestPrice || position.entryPrice);
        const newStop = lowest + trailingDistance;
        if (newStop < effectiveStop) {
          effectiveStop = newStop;
          result.newStopLoss = newStop;
        }
      }
    }

    // 3. check stop loss and take profit using effective stop
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

  // reset internal state for a symbol (end of day)
  reset(symbol: string): void {
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

  // return the strategy config
  getConfig(): StrategyConfig {
    return this.config;
  }

  //============================================================================
  // PRIVATE HELPERS
  //============================================================================

  // get internal state for a symbol, throw if not initialized
  private getState(symbol: string): ORBSymbolState {
    const state = this.symbolStates.get(symbol);
    if (!state) {
      throw new Error(`ORBStrategy: symbol ${symbol} not initialized`);
    }
    return state;
  }

  // check for breakout on a candle (no breakout detected yet)
  private checkForBreakout(symbol: string, candle: Candle, state: ORBSymbolState): CandleResult {
    const breakout = strategy.detectBreakout(candle, state.openingRange!, state.openingRangeAvgVolume);

    if (!breakout.detected) {
      return { signal: null, fvgPattern: null, done: false, rejectReason: "no breakout" };
    }

    // breakout found - start FVG window
    logger.normal(`Breakout detected for ${symbol}: ${breakout.direction}`);
    state.breakoutDetected = true;
    state.breakoutTimestamp = candle.timestamp;
    state.breakoutCandleWindow = [candle];

    return { signal: null, fvgPattern: null, done: false, rejectReason: "breakout detected, waiting for FVG" };
  }

  // check FVG pattern with 3 collected candles
  private checkFVGPattern(symbol: string, candle: Candle, state: ORBSymbolState): CandleResult {
    // determine direction from breakout
    const direction = candle.close > state.openingRange!.high ? "BULLISH" : "BEARISH";

    // check FVG using existing pure function
    const fvgPattern = strategy.detectFVG(
      state.breakoutCandleWindow,
      direction,
      this.legacyConfig,
      state.openingRangeAvgVolume,
    );

    if (!fvgPattern.detected) {
      // FVG not confirmed - done for this symbol
      logger.normal(`FVG not confirmed for ${symbol}`);
      state.done = true;
      return { signal: null, fvgPattern: null, done: true, rejectReason: fvgPattern.details || "FVG not met" };
    }

    // FVG confirmed - generate signal
    const breakoutResult = {
      detected: true as const,
      direction: (direction === "BULLISH" ? "ABOVE" : "BELOW") as "ABOVE" | "BELOW",
      candle,
      openingRange: state.openingRange!,
    };

    const signal = strategy.generateSignal(symbol, breakoutResult, fvgPattern, candle.close);
    if (!signal) {
      state.done = true;
      return { signal: null, fvgPattern: null, done: true, rejectReason: "signal generation failed" };
    }

    // signal generated - mark done after this
    state.done = true;
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

  // log the opening range filter scorecard (for debugging)
  private logFilterScorecard(
    symbol: string,
    candle: Candle,
    previousDayClose: number | null,
    openingRange: OpeningRange,
    strength: number,
  ): void {
    const cfg = this.config;
    logger.normal(`\n${"═".repeat(60)}`);
    logger.normal(`FILTER SCORECARD - ${symbol} Opening Range Analysis`);
    logger.normal(`${"═".repeat(60)}`);

    // gap filter
    if (previousDayClose !== null) {
      const gap = strategy.calculatePreMarketGap(candle, previousDayClose);
      const passed = Math.abs(gap) <= cfg.openingRange.maxPremarketGap;
      logger.normal(`${passed ? "✅" : "❌"} Gap: ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% (limit: ${cfg.openingRange.maxPremarketGap}%)`);
    } else {
      logger.normal(`⚪ Gap: Not checked (no prev close)`);
    }

    // range size
    const minPassed = openingRange.size >= cfg.openingRange.minSize;
    logger.normal(`${minPassed ? "✅" : "❌"} Min Size: ${openingRange.size.toFixed(2)}% (need ${cfg.openingRange.minSize}%)`);
    const maxPassed = openingRange.size <= cfg.openingRange.maxSize;
    logger.normal(`${maxPassed ? "✅" : "❌"} Max Size: ${openingRange.size.toFixed(2)}% (max ${cfg.openingRange.maxSize}%)`);

    // strength
    const strPassed = strength >= cfg.openingRange.minStrength;
    logger.normal(`${strPassed ? "✅" : "❌"} Strength: ${strength.toFixed(1)}/10 (need ${cfg.openingRange.minStrength})`);

    logger.normal(`${"═".repeat(60)}\n`);
  }

  // build a Config-compatible object from JSON config + global config
  // needed because existing pure functions (strategy.ts, positionSizer.ts, filters.ts) expect Config
  private buildLegacyConfig(): Config {
    const cfg = this.config;
    return {
      // global values from .env
      mode: this.globalConfig.mode,
      alpacaApiKey: this.globalConfig.alpacaApiKey,
      alpacaSecretKey: this.globalConfig.alpacaSecretKey,
      alpacaBaseUrl: this.globalConfig.alpacaBaseUrl,
      discordWebhookTrades: this.globalConfig.discordWebhookTrades,
      discordWebhookSystem: this.globalConfig.discordWebhookSystem,
      discordWebhookErrors: this.globalConfig.discordWebhookErrors,
      logLevel: this.globalConfig.logLevel,
      saveCandleData: this.globalConfig.saveCandleData,
      // strategy values from JSON
      symbols: cfg.symbols,
      maxTradesPerDay: cfg.maxTradesPerDay,
      strategyCutoffTime: cfg.schedule.tradingCutoff,
      positionSizeMode: cfg.positionSizing.mode,
      fixedPositionSize: cfg.positionSizing.fixedSize,
      accountRiskPercent: cfg.positionSizing.accountRiskPercent,
      maxPositionValue: cfg.positionSizing.maxValue,
      minPositionValue: cfg.positionSizing.minValue,
      riskRewardRatio: cfg.riskManagement.riskRewardRatio,
      stopLossBufferPercent: cfg.riskManagement.stopLossBufferPercent,
      useAtrStops: cfg.riskManagement.useAtrStops,
      atrPeriod: cfg.riskManagement.atrPeriod,
      atrStopMultiplier: cfg.riskManagement.atrStopMultiplier,
      useTrailingStops: cfg.riskManagement.useTrailingStops,
      trailingStopActivation: cfg.riskManagement.trailingStopActivation,
      trailingStopAtrMultiple: cfg.riskManagement.trailingStopAtrMultiple,
      usePartialExits: cfg.riskManagement.usePartialExits,
      partialExitAtRMultiple: cfg.riskManagement.partialExitAtRMultiple,
      partialExitPercent: cfg.riskManagement.partialExitPercent,
      useAdaptivePositionSizing: cfg.positionSizing.useAdaptive,
      weakSignalSizePercent: cfg.positionSizing.weakSignalSizePercent,
      openingRangeMinSize: cfg.openingRange.minSize,
      openingRangeMaxSize: cfg.openingRange.maxSize,
      fvgBodyPercent: cfg.fvg.bodyPercent,
      fvgMinRangePercent: cfg.fvg.minRangePercent,
      fvgOverlapTolerance: cfg.fvg.overlapTolerance,
      fvgClosePositionPercent: cfg.fvg.closePositionPercent,
      requireVolumeConfirmation: cfg.fvg.requireVolumeConfirmation,
      volumeMultiplier: cfg.fvg.volumeMultiplier,
      skipEarningsDays: cfg.openingRange.skipEarningsDays,
      openingRangeMinStrength: cfg.openingRange.minStrength,
      minAbsoluteVolumePerMinute: cfg.breakout.minAbsoluteVolume,
      maxFvgWindowMinutes: cfg.breakout.maxFvgWindowMinutes,
      maxPremarketGapPercent: cfg.openingRange.maxPremarketGap,
    };
  }
}
