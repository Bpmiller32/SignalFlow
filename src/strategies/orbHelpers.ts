// orbHelpers.ts - Pure functions for the ORB+FVG strategy
// All opening range, breakout, FVG, signal, position sizing, and filter logic
// lives here. These are pure functions with no side effects.
// Only orbStrategy.ts should import this file.

import {
  Candle,
  OpeningRange,
  Breakout,
  FVGPattern,
  Signal,
  PositionSize,
  ORFilterConfig,
  FVGConfig,
  PositionSizingConfig,
  RiskManagementConfig,
} from "../types";
import * as logger from "../logger";

// ════════════════════════════════════════════════════════════════════
// OPENING RANGE
// ════════════════════════════════════════════════════════════════════

// calculate the opening range from the first 5-min candle (9:30-9:35 AM EST)
export function calculateOpeningRange(candle: Candle): OpeningRange {
  const high = candle.high;
  const low = candle.low;
  const sizeInDollars = high - low;

  // range size as percentage of stock price using midpoint
  const midpoint = (high + low) / 2;
  const sizePercent = (sizeInDollars / midpoint) * 100;

  logger.normal(
    `Opening range calculated for ${candle.symbol}: High=${high}, Low=${low}, Size=${sizePercent.toFixed(2)}%`,
  );

  return {
    high,
    low,
    size: sizePercent,
    sizeInDollars,
    timestamp: candle.timestamp,
  };
}

// check if the opening range size is within acceptable limits
export function isOpeningRangeValid(
  openingRange: OpeningRange,
  orConfig: ORFilterConfig,
): boolean {
  const size = openingRange.size;

  // too tight = choppy/noisy price action
  if (size < orConfig.minSize) {
    logger.debug(
      `Opening range rejected: Too tight (${size.toFixed(2)}% < ${orConfig.minSize}%). Market may be choppy.`,
    );
    return false;
  }

  // too wide = volatile/gappy price action
  if (size > orConfig.maxSize) {
    logger.debug(
      `Opening range rejected: Too wide (${size.toFixed(2)}% > ${orConfig.maxSize}%). Market may be too volatile.`,
    );
    return false;
  }

  logger.normal(
    `Opening range valid: ${size.toFixed(2)}% (within ${orConfig.minSize}% - ${orConfig.maxSize}%)`,
  );
  return true;
}

// score opening range strength based on multiple factors (0-10 scale)
// stronger opening ranges lead to more reliable breakout signals
export function scoreOpeningRangeStrength(
  openingRange: OpeningRange,
  openingCandle: Candle,
  orConfig: ORFilterConfig,
): number {
  let score = 0;

  // factor 1: range size (ideal is mid-range, not too tight or too wide) - max 3 points
  const rangeSize = openingRange.size;
  const midpoint = (orConfig.minSize + orConfig.maxSize) / 2;
  const distanceFromMidpoint = Math.abs(rangeSize - midpoint);
  const maxDistance = orConfig.maxSize - orConfig.minSize;
  const sizeScore = (1 - distanceFromMidpoint / maxDistance) * 3;
  score += sizeScore;

  // factor 2: directional bias (close near high or low shows strength) - 2 points
  const candleRange = openingCandle.high - openingCandle.low;
  const closePosition = (openingCandle.close - openingCandle.low) / candleRange;
  if (closePosition > 0.7 || closePosition < 0.3) {
    score += 2;
  }

  // factor 3: volume (having volume data is a baseline positive) - 2 points
  const avgMinuteVolume = openingCandle.volume / 5;
  if (avgMinuteVolume > 0) {
    score += 2;
  }

  // factor 4: body size (larger body = more conviction) - 2 points
  const body = Math.abs(openingCandle.close - openingCandle.open);
  const bodyPercent = (body / candleRange) * 100;
  if (bodyPercent > 50) {
    score += 2;
  }

  // factor 5: base point for clean opening - 1 point
  score += 1;

  logger.debug(
    `Opening range strength: ${score.toFixed(1)}/10 (size: ${sizeScore.toFixed(1)}, bias: ${closePosition > 0.7 || closePosition < 0.3 ? 2 : 0}, body: ${bodyPercent.toFixed(0)}%)`,
  );

  // cap at 10
  return Math.min(score, 10);
}

// calculate average volume per minute from opening range candle (5-min candle / 5)
export function calculateOpeningRangeAvgVolume(
  openingRangeCandle: Candle,
): number {
  return openingRangeCandle.volume / 5;
}

// calculate pre-market gap as percentage (positive = gap up, negative = gap down)
export function calculatePreMarketGap(
  openingCandle: Candle,
  previousClose: number,
): number {
  const gapPercent = ((openingCandle.open - previousClose) / previousClose) * 100;
  logger.debug(
    `Pre-market gap: ${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}% (open: ${openingCandle.open}, prev close: ${previousClose})`,
  );
  return gapPercent;
}

// check if pre-market gap is too large for this strategy
// strategy works best on continuous price action, not gap fills
export function isPreMarketGapTooLarge(
  gapPercent: number,
  maxGapPercent: number = 1.0,
): boolean {
  const absGap = Math.abs(gapPercent);
  if (absGap > maxGapPercent) {
    logger.normal(
      `Pre-market gap too large: ${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}% (max: ${maxGapPercent}%)`,
    );
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════
// BREAKOUT DETECTION
// ════════════════════════════════════════════════════════════════════

// detect if a candle breaks above or below the opening range
// requires volume confirmation (20% above opening range average)
export function detectBreakout(
  candle: Candle,
  openingRange: OpeningRange,
  openingRangeAvgVolume: number,
): Breakout {
  // check for breakout above opening range (bullish)
  if (candle.high > openingRange.high) {
    // volume confirmation on breakout candle (mandatory)
    const requiredVolume = openingRangeAvgVolume * 1.2;
    if (candle.volume < requiredVolume) {
      logger.debug(
        `Breakout ABOVE rejected: Low volume (${candle.volume} < ${requiredVolume.toFixed(0)})`,
      );
      return { detected: false, direction: null, candle, openingRange };
    }

    logger.debug(
      `Breakout ABOVE detected: ${candle.symbol} broke ${openingRange.high} (high: ${candle.high}, volume: ${candle.volume})`,
    );
    return { detected: true, direction: "ABOVE", candle, openingRange };
  }

  // check for breakout below opening range (bearish)
  if (candle.low < openingRange.low) {
    // volume confirmation on breakout candle (mandatory)
    const requiredVolume = openingRangeAvgVolume * 1.2;
    if (candle.volume < requiredVolume) {
      logger.debug(
        `Breakout BELOW rejected: Low volume (${candle.volume} < ${requiredVolume.toFixed(0)})`,
      );
      return { detected: false, direction: null, candle, openingRange };
    }

    logger.debug(
      `Breakout BELOW detected: ${candle.symbol} broke ${openingRange.low} (low: ${candle.low}, volume: ${candle.volume})`,
    );
    return { detected: true, direction: "BELOW", candle, openingRange };
  }

  // no breakout detected
  return { detected: false, direction: null, candle, openingRange };
}

// ════════════════════════════════════════════════════════════════════
// FAIR VALUE GAP (FVG) PATTERN DETECTION
// ════════════════════════════════════════════════════════════════════

// detect FVG pattern for momentum confirmation
// requires 3 consecutive candles with specific characteristics
// bullish FVG: breakout candle + strong bullish momentum + gap up from candle 1
// bearish FVG: breakout candle + strong bearish momentum + gap down from candle 1
export function detectFVG(
  candles: Candle[],
  direction: "BULLISH" | "BEARISH",
  fvgConfig: FVGConfig,
  openingRangeAvgVolume?: number,
): FVGPattern {
  // must have exactly 3 candles
  if (candles.length !== 3) {
    return {
      detected: false,
      direction: null,
      candle1: candles[0],
      candle2: candles[1] || candles[0],
      candle3: candles[2] || candles[0],
      details: "Insufficient candles for FVG pattern (need 3)",
    };
  }

  const [candle1, candle2, candle3] = candles;

  // delegate to direction-specific detection
  if (direction === "BULLISH") {
    return detectBullishFVG(candle1, candle2, candle3, fvgConfig, openingRangeAvgVolume);
  } else {
    return detectBearishFVG(candle1, candle2, candle3, fvgConfig, openingRangeAvgVolume);
  }
}

// detect bullish FVG pattern (for LONG entries)
function detectBullishFVG(
  candle1: Candle,
  candle2: Candle,
  candle3: Candle,
  fvgConfig: FVGConfig,
  openingRangeAvgVolume?: number,
): FVGPattern {
  const symbol = candle1.symbol;

  // calculate candle 2 (momentum candle) characteristics
  const range2 = candle2.high - candle2.low;
  const body2 = candle2.close - candle2.open;
  const bodyPercent2 = range2 > 0 ? (body2 / range2) * 100 : 0;
  const midPrice = (candle2.high + candle2.low) / 2;
  const rangePercent2 = (range2 / midPrice) * 100;

  // check if candle 2 is bullish (close > open)
  if (candle2.close <= candle2.open) {
    logger.debug(`Bullish FVG rejected: Candle 2 is not bullish (close ${candle2.close} <= open ${candle2.open})`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: "Candle 2 is not bullish" };
  }

  // check body size requirement (body >= configured % of range)
  if (bodyPercent2 < fvgConfig.bodyPercent) {
    logger.debug(`Bullish FVG rejected: Body too small (${bodyPercent2.toFixed(1)}% < ${fvgConfig.bodyPercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Body too small: ${bodyPercent2.toFixed(1)}% (need ${fvgConfig.bodyPercent}%)` };
  }

  // check minimum range requirement (filters noise)
  if (rangePercent2 < fvgConfig.minRangePercent) {
    logger.debug(`Bullish FVG rejected: Range too small (${rangePercent2.toFixed(2)}% < ${fvgConfig.minRangePercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Range too small: ${rangePercent2.toFixed(2)}% (need ${fvgConfig.minRangePercent}%)` };
  }

  // check close position (must be in top portion of candle)
  const closePosition = ((candle2.close - candle2.low) / range2) * 100;
  const requiredClosePosition = 100 - fvgConfig.closePositionPercent;
  if (closePosition < requiredClosePosition) {
    logger.debug(`Bullish FVG rejected: Close not high enough (${closePosition.toFixed(1)}% < ${requiredClosePosition}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Close position too low: ${closePosition.toFixed(1)}% (need ${requiredClosePosition}%)` };
  }

  // check volume confirmation (optional based on config)
  if (fvgConfig.requireVolumeConfirmation && openingRangeAvgVolume) {
    const requiredVolume = openingRangeAvgVolume * fvgConfig.volumeMultiplier;
    if (candle2.volume < requiredVolume) {
      logger.debug(`Bullish FVG rejected: Volume too low (${candle2.volume} < ${requiredVolume.toFixed(0)})`);
      return { detected: false, direction: null, candle1, candle2, candle3, details: `Volume too low: ${candle2.volume} (need ${requiredVolume.toFixed(0)})` };
    }
  }

  // check gap condition between candle 1 and candle 3
  // overlap tolerance prevents being too strict
  const overlapThreshold = candle1.high * (1 - fvgConfig.overlapTolerance / 100);
  if (candle3.low < overlapThreshold) {
    logger.debug(`Bullish FVG rejected: No gap detected (candle3.low ${candle3.low} < threshold ${overlapThreshold.toFixed(2)})`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `No gap: candle3.low ${candle3.low.toFixed(2)} < candle1.high ${candle1.high.toFixed(2)}` };
  }

  // all conditions met - bullish FVG detected
  const details = `Bullish FVG: Body=${bodyPercent2.toFixed(1)}%, Range=${rangePercent2.toFixed(2)}%, Close@${closePosition.toFixed(1)}%, Gap=${(candle3.low - candle1.high).toFixed(2)}`;
  logger.normal(`✓ BULLISH FVG DETECTED for ${symbol}: ${details}`);

  return { detected: true, direction: "BULLISH", candle1, candle2, candle3, details };
}

// detect bearish FVG pattern (for SHORT entries) - mirror of bullish logic
function detectBearishFVG(
  candle1: Candle,
  candle2: Candle,
  candle3: Candle,
  fvgConfig: FVGConfig,
  openingRangeAvgVolume?: number,
): FVGPattern {
  const symbol = candle1.symbol;

  // calculate candle 2 (momentum candle) characteristics
  const range2 = candle2.high - candle2.low;
  const body2 = candle2.open - candle2.close; // bearish: open - close
  const bodyPercent2 = range2 > 0 ? (body2 / range2) * 100 : 0;
  const midPrice = (candle2.high + candle2.low) / 2;
  const rangePercent2 = (range2 / midPrice) * 100;

  // check if candle 2 is bearish (close < open)
  if (candle2.close >= candle2.open) {
    logger.debug(`Bearish FVG rejected: Candle 2 is not bearish (close ${candle2.close} >= open ${candle2.open})`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: "Candle 2 is not bearish" };
  }

  // check body size requirement
  if (bodyPercent2 < fvgConfig.bodyPercent) {
    logger.debug(`Bearish FVG rejected: Body too small (${bodyPercent2.toFixed(1)}% < ${fvgConfig.bodyPercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Body too small: ${bodyPercent2.toFixed(1)}% (need ${fvgConfig.bodyPercent}%)` };
  }

  // check minimum range requirement
  if (rangePercent2 < fvgConfig.minRangePercent) {
    logger.debug(`Bearish FVG rejected: Range too small (${rangePercent2.toFixed(2)}% < ${fvgConfig.minRangePercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Range too small: ${rangePercent2.toFixed(2)}% (need ${fvgConfig.minRangePercent}%)` };
  }

  // check close position (must be in bottom portion of candle)
  const closePosition = ((candle2.close - candle2.low) / range2) * 100;
  if (closePosition > fvgConfig.closePositionPercent) {
    logger.debug(`Bearish FVG rejected: Close not low enough (${closePosition.toFixed(1)}% > ${fvgConfig.closePositionPercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Close position too high: ${closePosition.toFixed(1)}% (need < ${fvgConfig.closePositionPercent}%)` };
  }

  // check volume confirmation (optional based on config)
  if (fvgConfig.requireVolumeConfirmation && openingRangeAvgVolume) {
    const requiredVolume = openingRangeAvgVolume * fvgConfig.volumeMultiplier;
    if (candle2.volume < requiredVolume) {
      logger.debug(`Bearish FVG rejected: Volume too low (${candle2.volume} < ${requiredVolume.toFixed(0)})`);
      return { detected: false, direction: null, candle1, candle2, candle3, details: `Volume too low: ${candle2.volume} (need ${requiredVolume.toFixed(0)})` };
    }
  }

  // check gap condition between candle 1 and candle 3
  const overlapThreshold = candle1.low * (1 + fvgConfig.overlapTolerance / 100);
  if (candle3.high > overlapThreshold) {
    logger.debug(`Bearish FVG rejected: No gap detected (candle3.high ${candle3.high} > threshold ${overlapThreshold.toFixed(2)})`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `No gap: candle3.high ${candle3.high.toFixed(2)} > candle1.low ${candle1.low.toFixed(2)}` };
  }

  // all conditions met - bearish FVG detected
  const details = `Bearish FVG: Body=${bodyPercent2.toFixed(1)}%, Range=${rangePercent2.toFixed(2)}%, Close@${closePosition.toFixed(1)}%, Gap=${(candle1.low - candle3.high).toFixed(2)}`;
  logger.normal(`✓ BEARISH FVG DETECTED for ${symbol}: ${details}`);

  return { detected: true, direction: "BEARISH", candle1, candle2, candle3, details };
}

// ════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION & QUALITY GRADING
// ════════════════════════════════════════════════════════════════════

// generate a trading signal from confirmed breakout + FVG pattern
export function generateSignal(
  symbol: string,
  breakout: Breakout,
  fvgPattern: FVGPattern,
  currentPrice: number,
): Signal | null {
  // must have both breakout and FVG pattern detected
  if (!breakout.detected) return null;
  if (!fvgPattern.detected) return null;

  // direction must match (breakout ABOVE = BULLISH FVG, breakout BELOW = BEARISH FVG)
  const direction = breakout.direction === "ABOVE" ? "LONG" : "SHORT";
  const expectedFVGDirection = breakout.direction === "ABOVE" ? "BULLISH" : "BEARISH";

  if (fvgPattern.direction !== expectedFVGDirection) {
    logger.debug(
      `Signal generation failed: Direction mismatch (breakout=${breakout.direction}, FVG=${fvgPattern.direction})`,
    );
    return null;
  }

  // build the signal
  const reason = `Opening range breakout ${breakout.direction} with ${fvgPattern.direction} FVG confirmation: ${fvgPattern.details}`;

  const signal: Signal = {
    symbol,
    direction,
    timestamp: new Date(),
    currentPrice,
    reason,
  };

  logger.normal(
    `🎯 SIGNAL GENERATED: ${direction} ${symbol} @ ${currentPrice} - ${reason}`,
  );

  return signal;
}

// grade signal quality by parsing FVG pattern details
// strong signals get full size, weak signals get reduced size
export function gradeSignalQuality(
  fvgPattern: FVGPattern,
  fvgConfig: FVGConfig,
): "STRONG" | "WEAK" {
  // start with assumption it's strong (it already passed basic FVG requirements)
  let qualityScore = 0;

  // parse FVG pattern details to extract metrics
  const details = fvgPattern.details;

  // extract body percentage from details string
  const bodyMatch = details.match(/Body=(\d+\.?\d*)%/);
  if (bodyMatch) {
    const bodyPercent = parseFloat(bodyMatch[1]);
    // if body is significantly above minimum (10% buffer), it's stronger
    if (bodyPercent >= fvgConfig.bodyPercent + 10) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Strong body (${bodyPercent}% vs ${fvgConfig.bodyPercent}% min)`,
      );
    }
  }

  // extract range percentage from details string
  const rangeMatch = details.match(/Range=(\d+\.?\d*)%/);
  if (rangeMatch) {
    const rangePercent = parseFloat(rangeMatch[1]);
    // if range is significantly above minimum (0.1% buffer), it's stronger
    if (rangePercent >= fvgConfig.minRangePercent + 0.1) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Strong range (${rangePercent}% vs ${fvgConfig.minRangePercent}% min)`,
      );
    }
  }

  // extract close position from details string
  const closeMatch = details.match(/Close@(\d+\.?\d*)%/);
  if (closeMatch) {
    const closePosition = parseFloat(closeMatch[1]);
    // for bullish, close should be high (>85%), for bearish, close should be low (<15%)
    if (
      (fvgPattern.direction === "BULLISH" && closePosition > 85) ||
      (fvgPattern.direction === "BEARISH" && closePosition < 15)
    ) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Excellent close position (${closePosition}%)`,
      );
    }
  }

  // extract gap size from details string
  const gapMatch = details.match(/Gap=(\d+\.?\d*)/);
  if (gapMatch) {
    const gapSize = parseFloat(gapMatch[1]);
    // check if gap is large as percentage of price
    const candle2Price = fvgPattern.candle2.close;
    const gapPercent = (gapSize / candle2Price) * 100;
    if (gapPercent > 0.3) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Large gap (${gapPercent.toFixed(2)}%)`,
      );
    }
  }

  // 3+ quality points = STRONG, less = WEAK
  const grade = qualityScore >= 3 ? "STRONG" : "WEAK";
  logger.normal(
    `Signal graded as ${grade} (quality score: ${qualityScore}/4)`,
  );

  return grade;
}

// ════════════════════════════════════════════════════════════════════
// OPENING RANGE STRENGTH FILTER
// ════════════════════════════════════════════════════════════════════

// return a multiplier for position size based on opening range strength
// strong (8-10) = full size, medium (5-7) = 75%, weak (<5) = rejected
export function adjustSizeForOpeningRangeStrength(
  strengthScore: number,
): number {
  if (strengthScore < 5) {
    logger.debug(`OR strength too weak: ${strengthScore.toFixed(1)}/10 - rejecting`);
    return 0;
  }
  if (strengthScore < 8) {
    logger.debug(`OR strength medium: ${strengthScore.toFixed(1)}/10 - reducing size to 75%`);
    return 0.75;
  }
  logger.debug(`OR strength strong: ${strengthScore.toFixed(1)}/10 - full size`);
  return 1.0;
}

// ════════════════════════════════════════════════════════════════════
// ATR CALCULATION
// ════════════════════════════════════════════════════════════════════

// calculate Average True Range (ATR) from recent candles
// ATR measures market volatility for adaptive stop placement
export function calculateATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) {
    logger.debug(`Not enough candles for ATR: ${candles.length} < ${period + 1}`);
    return 0;
  }

  const trueRanges: number[] = [];

  // calculate true range for each candle (needs previous close)
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    // true range = max of (high-low, |high-prevClose|, |low-prevClose|)
    const range = current.high - current.low;
    const gapUp = Math.abs(current.high - previous.close);
    const gapDown = Math.abs(current.low - previous.close);
    const trueRange = Math.max(range, gapUp, gapDown);
    trueRanges.push(trueRange);
  }

  // simple moving average of last N true ranges
  const recentTR = trueRanges.slice(-period);
  const atr = recentTR.reduce((sum, tr) => sum + tr, 0) / period;

  logger.debug(`ATR(${period}): ${atr.toFixed(2)}`);
  return atr;
}

// ════════════════════════════════════════════════════════════════════
// STOP LOSS & TAKE PROFIT
// ════════════════════════════════════════════════════════════════════

// calculate stop loss price based on risk management config
// ATR-based stops adapt to volatility, OR-based is the simpler fallback
export function calculateStopLoss(
  signal: Signal,
  openingRange: OpeningRange,
  riskConfig: RiskManagementConfig,
  recentCandles?: Candle[],
): number {
  // try ATR-based stops if enabled and candles available
  if (riskConfig.useAtrStops && recentCandles && recentCandles.length > 0) {
    const atr = calculateATR(recentCandles, riskConfig.atrPeriod);

    if (atr > 0) {
      // stop distance = ATR * multiplier
      const stopDistance = atr * riskConfig.atrStopMultiplier;

      if (signal.direction === "LONG") {
        const stopPrice = signal.currentPrice - stopDistance;
        logger.normal(`Using ATR stops: ${stopPrice.toFixed(2)} (${atr.toFixed(2)} × ${riskConfig.atrStopMultiplier})`);
        return stopPrice;
      } else {
        const stopPrice = signal.currentPrice + stopDistance;
        logger.normal(`Using ATR stops: ${stopPrice.toFixed(2)} (${atr.toFixed(2)} × ${riskConfig.atrStopMultiplier})`);
        return stopPrice;
      }
    } else {
      logger.normal("ATR stops unavailable - using opening range stops (fallback)");
    }
  }

  // fall back to opening range-based stops
  logger.normal("Using opening range stops");
  if (signal.direction === "LONG") {
    // for longs, stop below the opening range low with buffer
    const stopPrice = openingRange.low * (1 - riskConfig.stopLossBufferPercent / 100);
    logger.debug(`Stop loss (LONG, OR-based): ${stopPrice.toFixed(2)} = OR Low ${openingRange.low} - ${riskConfig.stopLossBufferPercent}% buffer`);
    return stopPrice;
  } else {
    // for shorts, stop above the opening range high with buffer
    const stopPrice = openingRange.high * (1 + riskConfig.stopLossBufferPercent / 100);
    logger.debug(`Stop loss (SHORT, OR-based): ${stopPrice.toFixed(2)} = OR High ${openingRange.high} + ${riskConfig.stopLossBufferPercent}% buffer`);
    return stopPrice;
  }
}

// calculate take profit price from entry, stop, and risk/reward ratio
export function calculateTakeProfit(
  entryPrice: number,
  stopPrice: number,
  direction: "LONG" | "SHORT",
  riskRewardRatio: number,
): number {
  // risk per share = distance from entry to stop
  const riskPerShare = Math.abs(entryPrice - stopPrice);

  // reward per share = risk * risk/reward ratio
  const rewardPerShare = riskPerShare * riskRewardRatio;

  // target price = entry +/- reward
  let targetPrice: number;
  if (direction === "LONG") {
    targetPrice = entryPrice + rewardPerShare;
  } else {
    targetPrice = entryPrice - rewardPerShare;
  }

  logger.debug(
    `Take profit (${direction}): ${targetPrice.toFixed(2)} = Entry ${entryPrice} ${direction === "LONG" ? "+" : "-"} ${rewardPerShare.toFixed(2)} (${riskRewardRatio}:1 R/R)`,
  );

  return targetPrice;
}

// ════════════════════════════════════════════════════════════════════
// POSITION SIZING
// ════════════════════════════════════════════════════════════════════

// calculate position size based on configured mode (FIXED or RISK_BASED)
export function calculatePositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  accountValue: number,
  sizingConfig: PositionSizingConfig,
  riskConfig: RiskManagementConfig,
  recentCandles?: Candle[],
): PositionSize | null {
  logger.debug(`Calculating position size for ${signal.direction} ${signal.symbol} | Mode: ${sizingConfig.mode}`);

  if (sizingConfig.mode === "FIXED") {
    return calculateFixedPositionSize(signal, openingRange, sizingConfig, riskConfig, recentCandles);
  } else {
    return calculateRiskBasedPositionSize(signal, openingRange, accountValue, sizingConfig, riskConfig, recentCandles);
  }
}

// calculate position size using FIXED mode (always trade a fixed dollar amount)
function calculateFixedPositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  sizingConfig: PositionSizingConfig,
  riskConfig: RiskManagementConfig,
  recentCandles?: Candle[],
): PositionSize | null {
  const entryPrice = signal.currentPrice;
  const stopPrice = calculateStopLoss(signal, openingRange, riskConfig, recentCandles);
  const targetPrice = calculateTakeProfit(entryPrice, stopPrice, signal.direction, riskConfig.riskRewardRatio);

  // validate stop and target are on correct side of entry
  if (!validateStopAndTarget(signal.direction, entryPrice, stopPrice, targetPrice)) {
    return null;
  }

  // calculate quantity from fixed dollar amount
  const dollarValue = sizingConfig.fixedSize;
  const quantity = Math.floor(dollarValue / entryPrice);

  // need at least 1 share
  if (quantity < 1) {
    logger.normal(`Position size too small: Fixed ${dollarValue} / Entry ${entryPrice} = ${quantity} shares (need at least 1)`);
    return null;
  }

  // recalculate actual dollar value based on whole shares
  const actualDollarValue = quantity * entryPrice;

  // check against max position value
  if (actualDollarValue > sizingConfig.maxValue) {
    logger.normal(`Position size exceeds max: ${actualDollarValue.toFixed(2)} > ${sizingConfig.maxValue}`);
    return null;
  }

  // check against min position value
  if (actualDollarValue < sizingConfig.minValue) {
    logger.normal(`Position size below min: ${actualDollarValue.toFixed(2)} < ${sizingConfig.minValue}`);
    return null;
  }

  // calculate risk and reward
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const totalRisk = riskPerShare * quantity;
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const potentialProfit = rewardPerShare * quantity;

  logger.normal(
    `Position sized (FIXED): ${quantity} shares @ ${entryPrice.toFixed(2)} = $${actualDollarValue.toFixed(2)} | Risk: $${totalRisk.toFixed(2)} | Reward: $${potentialProfit.toFixed(2)}`,
  );

  return {
    symbol: signal.symbol,
    quantity,
    dollarValue: actualDollarValue,
    entryPrice,
    stopPrice,
    targetPrice,
    riskPerShare,
    totalRisk,
    potentialProfit,
    riskRewardRatio: riskConfig.riskRewardRatio,
  };
}

// calculate position size using RISK_BASED mode (risk a fixed % of account)
function calculateRiskBasedPositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  accountValue: number,
  sizingConfig: PositionSizingConfig,
  riskConfig: RiskManagementConfig,
  recentCandles?: Candle[],
): PositionSize | null {
  const entryPrice = signal.currentPrice;
  const stopPrice = calculateStopLoss(signal, openingRange, riskConfig, recentCandles);
  const targetPrice = calculateTakeProfit(entryPrice, stopPrice, signal.direction, riskConfig.riskRewardRatio);

  // validate stop and target are on correct side of entry
  if (!validateStopAndTarget(signal.direction, entryPrice, stopPrice, targetPrice)) {
    return null;
  }

  // calculate risk per share and total risk amount
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const totalRiskAmount = accountValue * (sizingConfig.accountRiskPercent / 100);

  // quantity = total risk / risk per share
  const quantity = Math.floor(totalRiskAmount / riskPerShare);

  // need at least 1 share
  if (quantity < 1) {
    logger.normal(`Position size too small: Risk ${totalRiskAmount.toFixed(2)} / Risk/Share ${riskPerShare.toFixed(2)} = ${quantity} shares (need at least 1)`);
    return null;
  }

  // calculate actual dollar value
  const actualDollarValue = quantity * entryPrice;

  // check against max position value (cap if needed)
  if (actualDollarValue > sizingConfig.maxValue) {
    const maxQuantity = Math.floor(sizingConfig.maxValue / entryPrice);
    if (maxQuantity < 1) {
      logger.normal(`Cannot size position: Max position value ${sizingConfig.maxValue} / Entry ${entryPrice} = ${maxQuantity} shares`);
      return null;
    }

    logger.debug(`Position capped at max value: ${quantity} shares reduced to ${maxQuantity} shares`);

    // recalculate with capped quantity
    return buildPositionSize(signal, maxQuantity, entryPrice, stopPrice, targetPrice, riskConfig.riskRewardRatio);
  }

  // check against min position value
  if (actualDollarValue < sizingConfig.minValue) {
    logger.normal(`Position size below min: ${actualDollarValue.toFixed(2)} < ${sizingConfig.minValue}`);
    return null;
  }

  // calculate actual risk and reward with final quantity
  const actualTotalRisk = riskPerShare * quantity;
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const potentialProfit = rewardPerShare * quantity;

  logger.normal(
    `Position sized (RISK_BASED): ${quantity} shares @ ${entryPrice.toFixed(2)} = $${actualDollarValue.toFixed(2)} | Risk: $${actualTotalRisk.toFixed(2)} (${sizingConfig.accountRiskPercent}% of ${accountValue.toFixed(2)}) | Reward: $${potentialProfit.toFixed(2)}`,
  );

  return {
    symbol: signal.symbol,
    quantity,
    dollarValue: actualDollarValue,
    entryPrice,
    stopPrice,
    targetPrice,
    riskPerShare,
    totalRisk: actualTotalRisk,
    potentialProfit,
    riskRewardRatio: riskConfig.riskRewardRatio,
  };
}

// validate that a position size meets all requirements
export function validatePositionSize(
  positionSize: PositionSize,
  sizingConfig: PositionSizingConfig,
): boolean {
  // check quantity
  if (positionSize.quantity < 1) {
    logger.debug(`Invalid position size: Quantity ${positionSize.quantity} < 1`);
    return false;
  }

  // check dollar value against max
  if (positionSize.dollarValue > sizingConfig.maxValue) {
    logger.debug(`Invalid position size: Value ${positionSize.dollarValue} > max ${sizingConfig.maxValue}`);
    return false;
  }

  // check dollar value against min
  if (positionSize.dollarValue < sizingConfig.minValue) {
    logger.debug(`Invalid position size: Value ${positionSize.dollarValue} < min ${sizingConfig.minValue}`);
    return false;
  }

  // check that stop and target are not equal to entry
  if (positionSize.entryPrice === positionSize.stopPrice) {
    logger.debug(`Invalid position size: Entry equals stop price ${positionSize.entryPrice}`);
    return false;
  }

  if (positionSize.entryPrice === positionSize.targetPrice) {
    logger.debug(`Invalid position size: Entry equals target price ${positionSize.entryPrice}`);
    return false;
  }

  // all checks passed
  return true;
}

// ════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ════════════════════════════════════════════════════════════════════

// validate that stop and target are on the correct side of entry price
function validateStopAndTarget(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
): boolean {
  if (direction === "LONG") {
    if (stopPrice >= entryPrice) {
      logger.error(`Invalid LONG stop: ${stopPrice} >= entry ${entryPrice}`);
      return false;
    }
    if (targetPrice <= entryPrice) {
      logger.error(`Invalid LONG target: ${targetPrice} <= entry ${entryPrice}`);
      return false;
    }
  } else {
    if (stopPrice <= entryPrice) {
      logger.error(`Invalid SHORT stop: ${stopPrice} <= entry ${entryPrice}`);
      return false;
    }
    if (targetPrice >= entryPrice) {
      logger.error(`Invalid SHORT target: ${targetPrice} >= entry ${entryPrice}`);
      return false;
    }
  }
  return true;
}

// build a PositionSize with a specific quantity (used when capping at max value)
function buildPositionSize(
  signal: Signal,
  quantity: number,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
  riskRewardRatio: number,
): PositionSize {
  const dollarValue = quantity * entryPrice;
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const totalRisk = riskPerShare * quantity;
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const potentialProfit = rewardPerShare * quantity;

  return {
    symbol: signal.symbol,
    quantity,
    dollarValue,
    entryPrice,
    stopPrice,
    targetPrice,
    riskPerShare,
    totalRisk,
    potentialProfit,
    riskRewardRatio,
  };
}
