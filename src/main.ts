//==============================================================================
// MAIN.TS - MAIN ORCHESTRATION LOOP
//==============================================================================
// This is the entry point for the SignalFlow trading system.
// It orchestrates all components and manages the trading session lifecycle:
// 1. Pre-market: Wait for market open (6:30 AM PST / 9:30 AM EST)
// 2. Opening Range: Capture first 5-minute candle (9:30-9:35 AM EST)
// 3. Monitoring: Watch for breakouts and FVG patterns
// 4. Trading: Execute signals, monitor positions
// 5. End of Day: Close positions and shutdown (1:00 PM PST / 4:00 PM EST)
// The system runs independently per symbol and is resilient to crashes.
//==============================================================================

import config from "./config";
import * as logger from "./logger";
import * as timeUtils from "./timeUtils";
import * as discord from "./discord";
import * as alpacaData from "./alpacaData";
import * as paperBroker from "./paperBroker";
import * as strategy from "./strategy";
import * as positionSizer from "./positionSizer";
import * as state from "./state";
import * as filters from "./filters";
import {
  Candle,
  Signal,
  Position,
  PositionSize,
  DailyState,
  FVGPattern,
} from "./types";

//==============================================================================
// CONSTANTS
//==============================================================================

const OPENING_RANGE_START = "09:30"; // EST
const OPENING_RANGE_END = "09:35"; // EST (5 minutes)
const MARKET_CLOSE = "16:00"; // EST
const POLLING_INTERVAL_MS = 10000; // 10 seconds between candle checks
const OPENING_RANGE_POLL_MS = 5000; // 5 seconds during opening range capture

//==============================================================================
// GLOBAL STATE (per symbol)
//==============================================================================

interface SymbolState {
  symbol: string;
  dailyState: DailyState;
  currentPosition: Position | null;
  breakoutDetected: boolean;
  breakoutCandleWindow: Candle[] | null; // BUG FIX #2: Locked 3-candle window [breakout, momentum, gap]
  breakoutTimestamp: Date | null; // When breakout was first detected (for stale check)
  lastCandleTimestamp: Date | null;
  openingRangeStrength?: number; // Opening range strength score (0-10)
  previousDayClose?: number; // For pre-market gap detection
  recentCandlesBuffer: Candle[]; // ATR FIX: Rolling buffer of last 20 candles for ATR calculation
}

const symbolStates = new Map<string, SymbolState>();

//==============================================================================
// STARTUP AND INITIALIZATION
//==============================================================================

// Initialize the trading system on startup.
// Performs recovery and sets up initial state for all symbols.
async function startup(): Promise<void> {
  logger.separator();
  logger.normal(`🚀 SignalFlow Started | Mode: ${config.mode} | Symbols: ${config.symbols.join(", ")}`);
  logger.separator();

  // Send Discord startup notification
  await discord.sendStartup(config.mode, config.symbols);

  // Initialize paper broker if in PAPER mode
  if (config.mode === "PAPER") {
    paperBroker.initializePaperBroker(100000); // Start with $100k for realistic testing
    logger.normal("Paper broker initialized with $100,000");
  }

  // Perform startup recovery for each symbol
  for (const symbol of config.symbols) {
    logger.normal(`Initializing ${symbol}...`);

    // In PAPER mode, check paper broker for positions
    // In LIVE mode, would query Alpaca API
    let brokerPosition: Position | null = null;
    if (config.mode === "PAPER") {
      brokerPosition = paperBroker.getPosition(symbol);
    }

    // Perform recovery (reconcile files with broker)
    const recovery = state.performStartupRecovery(symbol, brokerPosition);

    // Initialize symbol state
    symbolStates.set(symbol, {
      symbol,
      dailyState: recovery.dailyState,
      currentPosition: recovery.position,
      breakoutDetected: false,
      breakoutCandleWindow: null, // BUG FIX #2: Locked 3-candle window for FVG
      breakoutTimestamp: null, // When breakout was first detected
      lastCandleTimestamp: null,
      openingRangeStrength: undefined,
      previousDayClose: undefined,
      recentCandlesBuffer: [], // ATR FIX: Initialize empty buffer for candle collection
    });

    logger.normal(
      `${symbol} initialized: Session=${recovery.dailyState.sessionStatus}, Position=${recovery.position ? "YES" : "NO"}`,
    );
  }

  logger.normal("System initialization complete");
}

//==============================================================================
// MARKET HOURS CHECKING
//==============================================================================

// Wait for market to open if we're before market hours.
// Checks every minute and logs status.
async function waitForMarketOpen(): Promise<void> {
  while (true) {
    const marketHours = timeUtils.getMarketHours();

    if (marketHours.isOpen) {
      logger.normal("Market is open - starting trading session");
      await discord.sendMarketStatus("Market Open");
      return;
    }

    const hoursUntilOpen = marketHours.hoursUntilOpen;
    logger.normal(
      `Market closed - Opening in ${hoursUntilOpen.toFixed(1)} hours (${marketHours.nextOpen.toLocaleString("en-US", { timeZone: "America/New_York" })} EST)`,
    );

    // If more than 1 hour away, log less frequently
    const waitTime = hoursUntilOpen > 1 ? 300000 : 60000; // 5 min vs 1 min
    await sleep(waitTime);
  }
}


// Check if we're past the strategy cutoff time (no new entries after this).
function isPastCutoffTime(): boolean {
  const now = new Date();
  const currentTime = timeUtils.formatTimeEST(now, "HH:mm");
  return currentTime >= config.strategyCutoffTime;
}

// Check if we're at or past market close time.
function isMarketClosing(): boolean {
  const now = new Date();
  const currentTime = timeUtils.formatTimeEST(now, "HH:mm");
  return currentTime >= MARKET_CLOSE;
}

//==============================================================================
// OPENING RANGE CAPTURE
//==============================================================================

// Capture the opening range for a symbol (9:30-9:35 AM EST).
// Fetches the 5-minute candle and validates it.

async function captureOpeningRange(symbol: string): Promise<void> {
  logger.normal(`Capturing opening range for ${symbol}...`);

  try {
    // Get the 5-minute opening candle
    const today = timeUtils.getTodayDateString();
    const candles = await alpacaData.fetch5MinCandles(symbol, today);

    if (candles.length === 0) {
      logger.error(`No opening range candle data for ${symbol}`);
      await discord.sendError(
        `Failed to capture opening range for ${symbol}`,
        "No data available",
      );
      return;
    }

    const openingCandle = candles[0];

    // IMPROVEMENT: Fetch previous day's close for gap detection
    const symbolState = symbolStates.get(symbol)!;
    try {
      const dailyCandles = await alpacaData.fetchDailyCandles(symbol, 2);
      if (dailyCandles.length >= 1) {
        symbolState.previousDayClose =
          dailyCandles[dailyCandles.length - 1].close;
        logger.debug(
          `Previous close for ${symbol}: ${symbolState.previousDayClose}`,
        );
      }
    } catch (error) {
      logger.debug(`Could not fetch previous close for ${symbol}`);
    }

    // IMPROVEMENT: Check for pre-market gap
    if (symbolState.previousDayClose) {
      const gapPercent = strategy.calculatePreMarketGap(
        openingCandle,
        symbolState.previousDayClose,
      );

      if (
        strategy.isPreMarketGapTooLarge(
          gapPercent,
          config.maxPremarketGapPercent,
        )
      ) {
        logger.normal(
          `Opening range rejected for ${symbol}: Pre-market gap too large (${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}%)`,
        );
        const reason = `Pre-market gap ${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}% exceeds ${config.maxPremarketGapPercent}% limit (gaps often fill intraday)`;
        await discord.sendOpeningRangeSkipped(symbol, reason);
        state.logRejection(symbol, "PRE_MARKET_GAP", reason, { gapPercent });

        // Mark as done for the day
        state.markTradeExecuted(symbol);
        symbolState.dailyState.sessionStatus = "DONE";
        return;
      }
    }

    // IMPROVEMENT: Check for earnings day (if enabled)
    if (config.skipEarningsDays) {
      try {
        const fs = require("fs");
        const path = require("path");
        const earningsPath = path.join(
          process.cwd(),
          "data",
          "earnings-calendar.json",
        );
        if (fs.existsSync(earningsPath)) {
          const calendar = JSON.parse(fs.readFileSync(earningsPath, "utf8"));
          const earningsDates = calendar[symbol] || [];
          if (earningsDates.includes(today)) {
            logger.normal(`Skipping ${symbol}: Earnings day`);
            const reason =
              "Earnings announcement today - avoiding unpredictable volatility";
            await discord.sendOpeningRangeSkipped(symbol, reason);
            state.logRejection(symbol, "EARNINGS_EVENT", reason);
            state.markTradeExecuted(symbol);
            symbolState.dailyState.sessionStatus = "DONE";
            return;
          }
        }
      } catch (error) {
        logger.debug(
          `Could not load earnings calendar: ${(error as Error).message}`,
        );
      }
    }

    // Calculate opening range
    const openingRange = strategy.calculateOpeningRange(openingCandle);
    
    // FILTER SCORECARD: Log all opening range filter checks
    logger.normal(`\n${"═".repeat(60)}`);
    logger.normal(`FILTER SCORECARD - ${symbol} Opening Range Analysis`);
    logger.normal(`${"═".repeat(60)}`);
    
    // Check 1: Gap filter (if previous close available)
    let gapPassed = true;
    if (symbolState.previousDayClose) {
      const gapPercent = strategy.calculatePreMarketGap(openingCandle, symbolState.previousDayClose);
      const gapFailed = Math.abs(gapPercent) > config.maxPremarketGapPercent;
      gapPassed = !gapFailed;
      logger.normal(`${gapPassed ? "✅" : "❌"} Filter 2: Pre-market Gap = ${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}% (limit: ${config.maxPremarketGapPercent}%)`);
    } else {
      logger.normal(`⚪ Filter 2: Pre-market Gap = Not checked (no prev close)`);
    }
    
    // Check 2: Range size min
    const sizeMinPassed = openingRange.size >= config.openingRangeMinSize;
    logger.normal(`${sizeMinPassed ? "✅" : "❌"} Filter 3: Range Min = ${openingRange.size.toFixed(2)}% (minimum: ${config.openingRangeMinSize}%)`);
    
    // Check 3: Range size max
    const sizeMaxPassed = openingRange.size <= config.openingRangeMaxSize;
    logger.normal(`${sizeMaxPassed ? "✅" : "❌"} Filter 4: Range Max = ${openingRange.size.toFixed(2)}% (maximum: ${config.openingRangeMaxSize}%)`);
    
    // Check 4: Range strength
    const orStrength = strategy.scoreOpeningRangeStrength(openingRange, openingCandle, config);
    symbolState.openingRangeStrength = orStrength;
    const strengthPassed = orStrength >= config.openingRangeMinStrength;
    logger.normal(`${strengthPassed ? "✅" : "❌"} Filter 5: Range Strength = ${orStrength.toFixed(1)}/10 (minimum: ${config.openingRangeMinStrength})`);
    
    logger.normal(`${"─".repeat(60)}`);
    const totalFilters = 4;
    const passedFilters = [gapPassed, sizeMinPassed, sizeMaxPassed, strengthPassed].filter(p => p).length;
    logger.normal(`RESULT: ${passedFilters}/${totalFilters} filters passed`);
    logger.normal(`${"═".repeat(60)}\n`);

    // Validate opening range
    const isValid = strategy.isOpeningRangeValid(
      openingRange,
      openingCandle.close,
      config,
    );

    if (!isValid) {
      logger.normal(
        `Opening range rejected for ${symbol} (size: ${openingRange.size.toFixed(2)}%)`,
      );
      const reason = `Range size ${openingRange.size.toFixed(2)}% outside ${config.openingRangeMinSize}% - ${config.openingRangeMaxSize}% limits (High: ${openingRange.high}, Low: ${openingRange.low})`;
      await discord.sendOpeningRangeSkipped(symbol, reason);
      state.logRejection(symbol, "OPENING_RANGE_SIZE", reason, {
        size: openingRange.size,
        minRequired: config.openingRangeMinSize,
        maxAllowed: config.openingRangeMaxSize,
      });

      // Mark as done for the day (don't try to trade)
      state.markTradeExecuted(symbol);
      symbolState.dailyState.sessionStatus = "DONE";
      return;
    }

    // BUG FIX #1: Apply opening range strength filter
    if (orStrength < config.openingRangeMinStrength) {
      logger.normal(
        `Opening range rejected for ${symbol}: Strength ${orStrength.toFixed(1)}/10 < minimum ${config.openingRangeMinStrength}`,
      );
      const reason = `Opening range strength ${orStrength.toFixed(1)}/10 below minimum ${config.openingRangeMinStrength} (weak setup quality)`;
      await discord.sendOpeningRangeSkipped(symbol, reason);
      state.logRejection(symbol, "OPENING_RANGE_STRENGTH", reason, {
        orStrength,
        minRequired: config.openingRangeMinStrength,
      });

      // Mark as done for the day
      state.markTradeExecuted(symbol);
      symbolState.dailyState.sessionStatus = "DONE";
      return;
    }

    // Save opening range to state
    state.updateOpeningRange(symbol, openingRange);

    symbolState.dailyState.openingRange = openingRange;
    symbolState.dailyState.openingRangeCandle = openingCandle; // Store full candle for volume/ATR
    symbolState.dailyState.sessionStatus = "MONITORING";

    logger.normal(
      `📊 OPENING RANGE: ${symbol} | High: $${openingRange.high.toFixed(2)} | Low: $${openingRange.low.toFixed(2)} | Size: ${openingRange.size.toFixed(2)}%`,
    );

    await discord.sendOpeningRange(
      symbol,
      openingRange.high,
      openingRange.low,
      openingRange.size,
    );
  } catch (error) {
    logger.error(
      `Failed to capture opening range for ${symbol}`,
      error as Error,
    );
    await discord.sendError(
      `Error capturing opening range for ${symbol}`,
      (error as Error).message,
    );
  }
}

//==============================================================================
// SIGNAL DETECTION AND TRADING
//==============================================================================

// Process a new 1-minute candle for a symbol.
// Checks for breakouts, FVG patterns, and generates signals.
async function processCandle(symbol: string, candle: Candle): Promise<void> {
  const symbolState = symbolStates.get(symbol)!;

  // Skip if already traded today
  if (symbolState.dailyState.tradeExecutedToday) {
    logger.debug(`Skipping ${symbol} - already traded today`);
    return;
  }

  // Skip if past cutoff time
  if (isPastCutoffTime()) {
    logger.debug(`Skipping ${symbol} - past cutoff time`);
    return;
  }

  // Need opening range to proceed
  if (!symbolState.dailyState.openingRange) {
    logger.debug(`Skipping ${symbol} - no opening range yet`);
    return;
  }

  const openingRange = symbolState.dailyState.openingRange;
  const openingRangeCandle = symbolState.dailyState.openingRangeCandle;

  // BUG FIX #3: Volume is now mandatory - must have opening range candle
  if (!openingRangeCandle) {
    logger.debug(
      `Skipping ${symbol} - no opening range candle data for volume checks`,
    );
    return;
  }

  const openingRangeAvgVol =
    strategy.calculateOpeningRangeAvgVolume(openingRangeCandle);

  // SAFETY CHECK: Minimum absolute volume threshold (prevents low liquidity trades)
  if (candle.volume < config.minAbsoluteVolumePerMinute) {
    logger.debug(
      `Skipping ${symbol} - candle volume ${candle.volume} below minimum ${config.minAbsoluteVolumePerMinute}`,
    );
    return;
  }

  // BUG FIX #2: Improved breakout candle window logic
  // Once breakout is detected, we need exactly 3 candles: [breakout, momentum, gap]

  if (!symbolState.breakoutDetected) {
    // No breakout yet - check each new candle for breakout
    
    // BREAKOUT FILTER SCORECARD
    const breakoutAbove = candle.high > openingRange.high;
    const breakoutBelow = candle.low < openingRange.low;
    
    if (breakoutAbove || breakoutBelow) {
      const now = new Date();
      const ageMinutes = (now.getTime() - candle.timestamp.getTime()) / 60000;
      const direction = breakoutAbove ? "ABOVE" : "BELOW";
      const requiredVol = openingRangeAvgVol * 1.2;
      const volPassed = candle.volume >= requiredVol;
      const absVolPassed = candle.volume >= config.minAbsoluteVolumePerMinute;
      
      logger.normal(`\n${"═".repeat(60)}`);
      logger.normal(`BREAKOUT FILTERS - ${symbol} ${direction}`);
      logger.normal(`${"═".repeat(60)}`);
      logger.normal(`${volPassed ? "✅" : "❌"} Filter 6: Breakout Volume = ${candle.volume.toLocaleString()} (need ${requiredVol.toFixed(0)})`);
      logger.normal(`${absVolPassed ? "✅" : "❌"} Filter 7: Absolute Min Volume = ${candle.volume.toLocaleString()} (need ${config.minAbsoluteVolumePerMinute.toLocaleString()})`);
      logger.normal(`✅ Filter 8: Stale Data = ${ageMinutes.toFixed(1)} min old (limit: 2.0 min)`);
      logger.normal(`${"─".repeat(60)}`);
      logger.normal(`RESULT: ${volPassed && absVolPassed ? "PASS - Breakout confirmed" : "FAIL - Insufficient volume"}`);
      logger.normal(`${"═".repeat(60)}\n`);
    }
    
    const breakout = strategy.detectBreakout(
      candle,
      openingRange,
      openingRangeAvgVol,
    );

    if (breakout.detected) {
      logger.normal(`✅ Breakout detected for ${symbol}: ${breakout.direction}`);
      symbolState.breakoutDetected = true;
      symbolState.breakoutTimestamp = candle.timestamp;
      symbolState.breakoutCandleWindow = [candle];

      logger.debug(
        `Started FVG window with breakout candle at ${candle.timestamp.toISOString()}`,
      );

      state.logRejection(
        symbol,
        "BREAKOUT_VOLUME",
        `Breakout ${breakout.direction} detected, waiting for FVG confirmation`,
        {
          breakoutPrice: candle.close,
          breakoutVolume: candle.volume,
          direction: breakout.direction,
        },
      );
    }

    return;
  }

  // BUG FIX #5: Check if breakout window has gone stale (too much time elapsed)
  if (symbolState.breakoutTimestamp) {
    const minutesSinceBreakout =
      (candle.timestamp.getTime() - symbolState.breakoutTimestamp.getTime()) /
      60000;
    if (minutesSinceBreakout > config.maxFvgWindowMinutes) {
      logger.normal(
        `Stale breakout timeout for ${symbol}: ${minutesSinceBreakout.toFixed(1)} minutes elapsed (max: ${config.maxFvgWindowMinutes})`,
      );
      state.logRejection(
        symbol,
        "FVG_PATTERN",
        `Breakout went stale - ${minutesSinceBreakout.toFixed(1)} minutes without FVG confirmation`,
        { minutesSinceBreakout, maxAllowed: config.maxFvgWindowMinutes },
      );
      symbolState.dailyState.sessionStatus = "DONE";
      return;
    }
  }

  // Breakout already detected - collecting 2 more candles for FVG check
  if (
    symbolState.breakoutCandleWindow &&
    symbolState.breakoutCandleWindow.length < 3
  ) {
    symbolState.breakoutCandleWindow.push(candle);
    logger.debug(
      `Added candle to FVG window: ${symbolState.breakoutCandleWindow.length}/3 candles`,
    );

    if (symbolState.breakoutCandleWindow.length < 3) {
      return; // Need one more candle
    }
  }

  // Now we have exactly 3 candles - check for FVG pattern
  if (
    symbolState.breakoutCandleWindow &&
    symbolState.breakoutCandleWindow.length === 3
  ) {
    const direction = candle.close > openingRange.high ? "BULLISH" : "BEARISH";

    const fvgPattern = strategy.detectFVG(
      symbolState.breakoutCandleWindow,
      direction,
      config,
      openingRangeAvgVol,
    );

    if (fvgPattern.detected) {
      // Generate signal
      const signal = strategy.generateSignal(
        symbol,
        {
          detected: true,
          direction: direction === "BULLISH" ? "ABOVE" : "BELOW",
          candle,
          openingRange,
        },
        fvgPattern,
        candle.close,
      );

      if (signal) {
        await executeSignal(symbol, signal, openingRange, fvgPattern);
      }

      // BUG FIX: Always mark as DONE after signal processing attempt
      // This prevents re-processing the same 3-candle window if executeSignal
      // fails early (due to position sizing, strength filters, etc.)
      // Only mark as DONE if we didn't successfully open a position
      if (symbolState.dailyState.sessionStatus !== "POSITION_OPEN") {
        logger.debug(
          `Marking ${symbol} as DONE - signal generated but position not opened`,
        );
        symbolState.dailyState.sessionStatus = "DONE";
        state.markTradeExecuted(symbol); // Count as trade attempt
      }
    } else {
      // FVG pattern not detected - mark as done (only 1 trade attempt per day)
      logger.normal(`FVG pattern not confirmed for ${symbol} - no trade today`);
      state.logRejection(
        symbol,
        "FVG_PATTERN",
        fvgPattern.details || "FVG pattern requirements not met",
        {
          direction,
          candleCount: symbolState.breakoutCandleWindow.length,
        },
      );
      symbolState.dailyState.sessionStatus = "DONE";
    }
  }
}

// Execute a trading signal - calculate position size and place orders.
async function executeSignal(
  symbol: string,
  signal: Signal,
  openingRange: any,
  fvgPattern: FVGPattern,
): Promise<void> {
  const emoji = signal.direction === "LONG" ? "⬆️" : "⬇️";
  logger.normal(`${emoji} SIGNAL: ${signal.direction} ${symbol} | ${signal.reason}`);

  try {
    // FILTER 3: Grade signal quality for adaptive position sizing (if enabled)
    let signalQuality: "STRONG" | "WEAK" = "STRONG";
    if (config.useAdaptivePositionSizing) {
      signalQuality = filters.gradeSignalQuality(fvgPattern, config);
    }

    // Calculate position size (pass recent candles for ATR calculation)
    const accountInfo =
      config.mode === "PAPER"
        ? paperBroker.getAccountInfo()
        : { equity: 100000 }; // Placeholder for live mode

    const symState = symbolStates.get(symbol)!;
    // ATR FIX: Pass the rolling candle buffer (has 20+ candles) instead of FVG window (only 3)
    const recentCandles =
      symState.recentCandlesBuffer.length >= config.atrPeriod + 1
        ? symState.recentCandlesBuffer
        : []; // Use buffer if we have enough candles, otherwise empty array (will fall back to OR stops)

    let positionSize = positionSizer.calculatePositionSize(
      signal,
      openingRange,
      accountInfo.equity,
      config,
      recentCandles,
    );

    if (!positionSize) {
      logger.normal(`Cannot size position for ${symbol} - skipping trade`);
      return;
    }

    // BUG FIX #1: Apply opening range strength size adjustment
    if (symState.openingRangeStrength !== undefined) {
      const strengthMultiplier = filters.adjustSizeForOpeningRangeStrength(
        symState.openingRangeStrength,
      );

      if (strengthMultiplier === 0) {
        logger.normal(
          `Trade rejected for ${symbol}: OR strength too low for trading`,
        );
        state.logRejection(
          symbol,
          "OPENING_RANGE_STRENGTH",
          `OR strength ${symState.openingRangeStrength.toFixed(1)}/10 below trading threshold`,
        );
        return;
      }

      if (strengthMultiplier < 1.0) {
        const originalQty = positionSize.quantity;
        positionSize.quantity = Math.floor(
          positionSize.quantity * strengthMultiplier,
        );
        positionSize.dollarValue =
          positionSize.quantity * positionSize.entryPrice;
        positionSize.totalRisk =
          positionSize.quantity * positionSize.riskPerShare;
        positionSize.potentialProfit =
          positionSize.quantity *
          (positionSize.targetPrice - positionSize.entryPrice);

        logger.normal(
          `OR strength adjustment: ${originalQty} → ${positionSize.quantity} shares (${(strengthMultiplier * 100).toFixed(0)}% size)`,
        );
      }
    }

    // Apply adaptive sizing if signal is WEAK
    if (signalQuality === "WEAK" && config.useAdaptivePositionSizing) {
      const adjustmentFactor = config.weakSignalSizePercent / 100;
      const originalQty = positionSize.quantity;
      positionSize.quantity = Math.floor(
        positionSize.quantity * adjustmentFactor,
      );
      positionSize.dollarValue =
        positionSize.quantity * positionSize.entryPrice;
      positionSize.totalRisk =
        positionSize.quantity * positionSize.riskPerShare;
      positionSize.potentialProfit =
        positionSize.quantity *
        (positionSize.targetPrice - positionSize.entryPrice);

      logger.normal(
        `Weak signal adjustment: ${originalQty} → ${positionSize.quantity} shares (${config.weakSignalSizePercent}% size)`,
      );
    }

    // Final validation after all adjustments
    if (positionSize.quantity < 1) {
      logger.normal(
        `Position size too small after adjustments for ${symbol} - skipping trade`,
      );
      return;
    }

    // Validate position size
    if (!positionSizer.validatePositionSize(positionSize, config)) {
      logger.normal(
        `Position size validation failed for ${symbol} - skipping trade`,
      );
      return;
    }

    // Execute trade based on mode
    let position: Position | null = null;

    if (config.mode === "PAPER") {
      position = paperBroker.openPosition(positionSize);
    } else {
      // TODO: Alpaca integration
      logger.error("LIVE mode not yet implemented");
      return;
    }

    if (!position) {
      logger.error(`Failed to open position for ${symbol}`);
      await discord.sendError(`Failed to open position for ${symbol}`);
      return;
    }

    // Update state
    const symState2 = symbolStates.get(symbol)!;
    symState2.currentPosition = position;
    symState2.dailyState.sessionStatus = "POSITION_OPEN";

    state.saveCurrentPosition(position);
    state.markTradeExecuted(symbol);

    // Send Discord notification
    await discord.sendTradeEntry(
      symbol,
      signal.direction,
      positionSize.entryPrice,
      positionSize.quantity,
      positionSize.stopPrice,
      positionSize.targetPrice,
      positionSize.totalRisk,
      positionSize.potentialProfit,
    );

    logger.normal(
      `🟢 TRADE ENTRY: ${signal.direction} ${positionSize.quantity} shares of ${symbol} @ $${positionSize.entryPrice.toFixed(2)}`,
    );
  } catch (error) {
    logger.error(`Error executing signal for ${symbol}`, error as Error);
    await discord.sendError(
      `Error executing trade for ${symbol}`,
      (error as Error).message,
    );
  }
}

//==============================================================================
// POSITION MONITORING
//==============================================================================

// Monitor open positions for stop loss, take profit, trailing stops, and partial exits.
async function monitorPositions(candle: Candle): Promise<void> {
  const symbolState = symbolStates.get(candle.symbol);
  if (!symbolState || !symbolState.currentPosition) {
    return; // No position to monitor
  }

  const position = symbolState.currentPosition;

  // 1. Check for partial exit trigger (if enabled and not already executed)
  if (config.usePartialExits && !position.partialExitExecuted) {
    const shouldPartialExit =
      config.mode === "PAPER"
        ? paperBroker.checkPartialExitTrigger(
            position,
            candle.close,
            config.partialExitAtRMultiple,
          )
        : false; // TODO: Alpaca integration

    if (shouldPartialExit) {
      logger.normal(
        `Partial exit trigger reached for ${candle.symbol} at ${config.partialExitAtRMultiple}R`,
      );

      // Execute partial exit
      if (config.mode === "PAPER") {
        paperBroker.executePartialExit(
          position,
          candle.close,
          config.partialExitPercent,
        );

        // Activate trailing stop after partial exit
        if (config.useTrailingStops) {
          paperBroker.activateTrailingStop(position);
        }
      }

      // Save updated position state
      state.saveCurrentPosition(position);
    }
  }

  // 2. Update trailing stop if active (if enabled)
  if (config.useTrailingStops && position.trailingStopActive) {
    // Calculate trailing distance (use ATR if available)
    let trailingDistance: number;

    if (
      config.useAtrStops &&
      symbolState.breakoutCandleWindow &&
      symbolState.breakoutCandleWindow.length > config.atrPeriod
    ) {
      const atr = positionSizer.calculateATR(
        symbolState.breakoutCandleWindow,
        config.atrPeriod,
      );
      trailingDistance = atr * config.trailingStopAtrMultiple;
    } else {
      // Fall back to fixed percentage of price
      trailingDistance = candle.close * 0.01; // 1% default
    }

    if (config.mode === "PAPER") {
      paperBroker.updateTrailingStop(
        position,
        candle.high,
        candle.low,
        trailingDistance,
      );

      // Save updated position state
      state.saveCurrentPosition(position);
    }
  }

  // 3. Check if stop or target hit
  const result =
    config.mode === "PAPER"
      ? paperBroker.checkStopAndTarget(candle.symbol, candle)
      : null; // TODO: Alpaca integration

  if (result) {
    // Position was closed
    const exitPrice =
      result === "STOPPED" ? position.stopLoss : position.takeProfit;
    const exitReason = result === "STOPPED" ? "STOP_LOSS" : "TAKE_PROFIT";

    // Calculate P&L (considering original quantity for accurate tracking)
    let pnl: number;
    if (position.side === "LONG") {
      pnl = (exitPrice - position.entryPrice) * position.quantity;
    } else {
      pnl = (position.entryPrice - exitPrice) * position.quantity;
    }

    // Create trade record
    const trade = {
      id: `TRADE-${Date.now()}`,
      symbol: candle.symbol,
      side: position.side,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      quantity: position.originalQuantity, // Use original quantity for record
      exitTime: new Date(),
      exitPrice,
      exitReason: exitReason as any,
      pnl,
      pnlPercent:
        (pnl / (position.entryPrice * position.originalQuantity)) * 100,
      fees: 0,
      holdingTime: Math.floor(
        (Date.now() - position.entryTime.getTime()) / 1000,
      ),
    };

    // Save trade and update statistics
    state.saveTradeToHistory(trade);
    state.updateStatistics(trade);
    state.deleteCurrentPosition(candle.symbol);

    // Update symbol state
    symbolState.currentPosition = null;
    symbolState.dailyState.sessionStatus = "DONE";

    // Send Discord notification
    const duration = `${Math.floor(trade.holdingTime / 60)} minutes`;
    await discord.sendTradeExit(
      candle.symbol,
      exitPrice,
      pnl,
      trade.pnlPercent,
      exitReason,
      duration,
    );

    const pnlSign = pnl >= 0 ? "+" : "";
    logger.normal(
      `Position closed for ${candle.symbol}: ${exitReason} | P&L: ${pnlSign}$${pnl.toFixed(2)}`,
    );
  }
}

//==============================================================================
// MAIN MONITORING LOOP
//==============================================================================

// Main loop that runs during market hours.
// Fetches candles and processes them for all symbols.
async function monitoringLoop(): Promise<void> {
  logger.normal("Starting main monitoring loop...");

  while (!isMarketClosing()) {
    try {
      // Process each symbol
      for (const symbol of config.symbols) {
        const symbolState = symbolStates.get(symbol)!;

        // Skip if done for the day
        if (symbolState.dailyState.sessionStatus === "DONE") {
          continue;
        }

        // Fetch latest 1-minute candle
        const today = timeUtils.getTodayDateString();
        const candles = await alpacaData.fetch1MinCandles(symbol, today);

        if (candles.length === 0) {
          logger.debug(`No candle data for ${symbol}`);
          continue;
        }

        // Get the LATEST candle (most recent), not the first one
        const candle = candles[candles.length - 1];

        // STALE DATA CHECK: Reject candles older than 2 minutes
        const now = new Date();
        const candleAgeMinutes =
          (now.getTime() - candle.timestamp.getTime()) / 60000;
        if (candleAgeMinutes > 2) {
          logger.error(
            `Stale candle data for ${symbol}: ${candleAgeMinutes.toFixed(1)} minutes old (rejecting)`,
          );
          await discord.sendError(
            `Stale data for ${symbol}`,
            `Candle is ${candleAgeMinutes.toFixed(1)} minutes old (> 2 min threshold)`,
          );
          continue;
        }

        // Skip if we've already processed this candle
        if (
          symbolState.lastCandleTimestamp &&
          candle.timestamp.getTime() ===
            symbolState.lastCandleTimestamp.getTime()
        ) {
          continue;
        }

        symbolState.lastCandleTimestamp = candle.timestamp;

        // ATR FIX: Add candle to rolling buffer (keep last 20 candles)
        symbolState.recentCandlesBuffer.push(candle);
        if (symbolState.recentCandlesBuffer.length > 20) {
          symbolState.recentCandlesBuffer.shift(); // Remove oldest
        }

        // Monitor positions first (check stops/targets)
        await monitorPositions(candle);

        // Then check for new signals
        await processCandle(symbol, candle);
      }
    } catch (error) {
      logger.error("Error in monitoring loop", error as Error);
      await discord.sendError(
        "Monitoring loop error",
        (error as Error).message,
      );
    }

    // Wait before next poll
    await sleep(POLLING_INTERVAL_MS);
  }

  logger.normal("Market closing - ending monitoring loop");
}

//==============================================================================
// END OF DAY SHUTDOWN
//==============================================================================

// Perform end-of-day shutdown and cleanup.
async function shutdown(): Promise<void> {
  logger.separator();
  logger.normal("Performing end-of-day shutdown...");

  // Close any remaining positions
  for (const symbol of config.symbols) {
    const symbolState = symbolStates.get(symbol);
    if (symbolState && symbolState.currentPosition) {
      logger.normal(`Closing end-of-day position for ${symbol}`);

      // Get current price (use latest candle)
      const today = timeUtils.getTodayDateString();
      const candles = await alpacaData.fetch1MinCandles(symbol, today);
      const currentPrice =
        candles.length > 0
          ? candles[candles.length - 1].close
          : symbolState.currentPosition.entryPrice;

      // Close position
      if (config.mode === "PAPER") {
        paperBroker.closePositionManual(symbol, currentPrice);
      }

      // Update state
      state.deleteCurrentPosition(symbol);
      symbolState.currentPosition = null;
    }
  }

  // Load final statistics
  const stats = state.loadAllTimeStats();

  // Get account balance
  const accountBalance =
    config.mode === "PAPER" ? paperBroker.getAccountInfo().equity : 0; // For live mode, we'd get this from Alpaca

  // Load today's trades to find best/worst
  const todayHistory = state.loadTradeHistory(timeUtils.getTodayDateString());
  let bestTradePnL: number | null = null;
  let worstTradePnL: number | null = null;

  if (todayHistory && todayHistory.trades.length > 0) {
    const pnls = todayHistory.trades.map((t) => t.pnl);
    bestTradePnL = Math.max(...pnls);
    worstTradePnL = Math.min(...pnls);
  }

  // Load rejection summary for analysis
  const rejectionSummary = state.getRejectionSummary(
    timeUtils.getTodayDateString(),
  );
  logger.normal(
    `Rejection summary: ${rejectionSummary.total} total rejections`,
  );
  if (rejectionSummary.total > 0) {
    logger.normal(`  By stage: ${JSON.stringify(rejectionSummary.byStage)}`);
    logger.normal(`  By symbol: ${JSON.stringify(rejectionSummary.bySymbol)}`);
  }

  // Format current streak
  const currentStreak = {
    type:
      stats.allTimeStats.currentStreak.type === "WIN"
        ? ("win" as const)
        : stats.allTimeStats.currentStreak.type === "LOSS"
          ? ("loss" as const)
          : ("none" as const),
    count: stats.allTimeStats.currentStreak.count,
  };

  // Send end-of-day summary
  await discord.sendDailySummary(
    timeUtils.getTodayDateString(),
    config.symbols,
    stats.allTimeStats.totalTrades,
    stats.allTimeStats.wins,
    stats.allTimeStats.losses,
    stats.allTimeStats.totalPnL,
    accountBalance,
    bestTradePnL,
    worstTradePnL,
    currentStreak,
  );

  logger.normal("🌙 SignalFlow Shutdown | End of trading day");
  logger.separator();
}

//==============================================================================
// MAIN ENTRY POINT
//==============================================================================

// Main entry point for the trading system.
async function main(): Promise<void> {
  try {
    // Startup
    await startup();

    // Wait for market open
    await waitForMarketOpen();

    // Send market open summary (mobile-friendly overview)
    await discord.sendMarketOpenSummary(
      timeUtils.getTodayDateString(),
      config.symbols.length,
      config.symbols,
      config.maxTradesPerDay,
      config.strategyCutoffTime,
    );

    // Wait until 9:35 AM EST to capture opening range
    await waitUntilTime(OPENING_RANGE_END);

    // Capture opening range for all symbols
    for (const symbol of config.symbols) {
      await captureOpeningRange(symbol);
    }

    // Start main monitoring loop
    await monitoringLoop();

    // Shutdown
    await shutdown();
  } catch (error) {
    logger.error("Critical error in main loop", error as Error);
    await discord.sendError("CRITICAL ERROR", (error as Error).message);
    process.exit(1);
  }
}

//==============================================================================
// UTILITY FUNCTIONS
//==============================================================================

// Sleep for a specified number of milliseconds.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until a specific time (HH:mm format in EST).
async function waitUntilTime(targetTime: string): Promise<void> {
  while (true) {
    // Get current time in EST (market timezone)
    const nowEST = timeUtils.getCurrentEstTime();
    const currentTime = timeUtils.formatTimeEST(nowEST, "HH:mm");

    if (currentTime >= targetTime) {
      return;
    }

    logger.debug(`Waiting for ${targetTime} EST (current: ${currentTime} EST)`);
    await sleep(30000); // Check every 30 seconds
  }
}

//==============================================================================
// START THE SYSTEM
//==============================================================================

// Run main function
main().catch((error) => {
  logger.error("Unhandled error in main", error as Error);
  process.exit(1);
});
