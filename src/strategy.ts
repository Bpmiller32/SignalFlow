// strategy.ts - Opening Range Breakout with FVG confirmation
// Core trading strategy logic as pure functions:
// 1. Calculate opening range from first 5-min candle (9:30-9:35 AM EST)
// 2. Validate range size (filter too tight or too volatile ranges)
// 3. Detect breakouts above/below opening range
// 4. Confirm momentum using Fair Value Gap (FVG) pattern
// 5. Generate trading signals (LONG/SHORT)

import {
  Candle,
  OpeningRange,
  Breakout,
  FVGPattern,
  Signal,
  Config,
} from "./types";
import * as logger from "./logger";

// ---- OPENING RANGE CALCULATION ----

// calculate the opening range from the first 5-min candle (9:30-9:35 AM EST)
export function calculateOpeningRange(candle: Candle): OpeningRange {
  const high = candle.high;
  const low = candle.low;
  const sizeInDollars = high - low;

  // calculate range size as percentage of stock price using midpoint
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

// validate if the opening range meets size requirements
export function isOpeningRangeValid(
  openingRange: OpeningRange,
  _currentPrice: number,
  config: Config,
): boolean {
  const size = openingRange.size;
  const minSize = config.openingRangeMinSize;
  const maxSize = config.openingRangeMaxSize;

  // check if range is too tight (choppy/noisy)
  if (size < minSize) {
    logger.debug(
      `Opening range rejected: Too tight (${size.toFixed(2)}% < ${minSize}%). Market may be choppy.`,
    );
    return false;
  }

  // check if range is too wide (volatile/gappy)
  if (size > maxSize) {
    logger.debug(
      `Opening range rejected: Too wide (${size.toFixed(2)}% > ${maxSize}%). Market may be too volatile.`,
    );
    return false;
  }

  logger.normal(
    `Opening range valid: ${size.toFixed(2)}% (within ${minSize}% - ${maxSize}%)`,
  );
  return true;
}

// ---- BREAKOUT DETECTION ----

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

// ---- FAIR VALUE GAP (FVG) PATTERN DETECTION ----

// detect FVG pattern for momentum confirmation
// requires 3 consecutive candles with specific characteristics
// bullish FVG: breakout candle + strong bullish momentum + gap up from candle 1
// bearish FVG: breakout candle + strong bearish momentum + gap down from candle 1
export function detectFVG(
  candles: Candle[],
  direction: "BULLISH" | "BEARISH",
  config: Config,
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
    return detectBullishFVG(candle1, candle2, candle3, config, openingRangeAvgVolume);
  } else {
    return detectBearishFVG(candle1, candle2, candle3, config, openingRangeAvgVolume);
  }
}

// detect bullish FVG pattern (for LONG entries)
function detectBullishFVG(
  candle1: Candle,
  candle2: Candle,
  candle3: Candle,
  config: Config,
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
  if (bodyPercent2 < config.fvgBodyPercent) {
    logger.debug(`Bullish FVG rejected: Body too small (${bodyPercent2.toFixed(1)}% < ${config.fvgBodyPercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Body too small: ${bodyPercent2.toFixed(1)}% (need ${config.fvgBodyPercent}%)` };
  }

  // check minimum range requirement (filters noise)
  if (rangePercent2 < config.fvgMinRangePercent) {
    logger.debug(`Bullish FVG rejected: Range too small (${rangePercent2.toFixed(2)}% < ${config.fvgMinRangePercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Range too small: ${rangePercent2.toFixed(2)}% (need ${config.fvgMinRangePercent}%)` };
  }

  // check close position (must be in top 25% of candle)
  const closePosition = ((candle2.close - candle2.low) / range2) * 100;
  const requiredClosePosition = 100 - config.fvgClosePositionPercent;
  if (closePosition < requiredClosePosition) {
    logger.debug(`Bullish FVG rejected: Close not in top 25% (${closePosition.toFixed(1)}% < ${requiredClosePosition}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Close position too low: ${closePosition.toFixed(1)}% (need ${requiredClosePosition}%)` };
  }

  // check volume confirmation (optional based on config)
  if (config.requireVolumeConfirmation && openingRangeAvgVolume) {
    const requiredVolume = openingRangeAvgVolume * config.volumeMultiplier;
    if (candle2.volume < requiredVolume) {
      logger.debug(`Bullish FVG rejected: Volume too low (${candle2.volume} < ${requiredVolume.toFixed(0)})`);
      return { detected: false, direction: null, candle1, candle2, candle3, details: `Volume too low: ${candle2.volume} (need ${requiredVolume.toFixed(0)})` };
    }
  }

  // check gap condition between candle 1 and candle 3
  // allowed overlap tolerance prevents being too strict
  const overlapThreshold = candle1.high * (1 - config.fvgOverlapTolerance / 100);
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
  config: Config,
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
  if (bodyPercent2 < config.fvgBodyPercent) {
    logger.debug(`Bearish FVG rejected: Body too small (${bodyPercent2.toFixed(1)}% < ${config.fvgBodyPercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Body too small: ${bodyPercent2.toFixed(1)}% (need ${config.fvgBodyPercent}%)` };
  }

  // check minimum range requirement
  if (rangePercent2 < config.fvgMinRangePercent) {
    logger.debug(`Bearish FVG rejected: Range too small (${rangePercent2.toFixed(2)}% < ${config.fvgMinRangePercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Range too small: ${rangePercent2.toFixed(2)}% (need ${config.fvgMinRangePercent}%)` };
  }

  // check close position (must be in bottom 25% of candle)
  const closePosition = ((candle2.close - candle2.low) / range2) * 100;
  if (closePosition > config.fvgClosePositionPercent) {
    logger.debug(`Bearish FVG rejected: Close not in bottom 25% (${closePosition.toFixed(1)}% > ${config.fvgClosePositionPercent}%)`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `Close position too high: ${closePosition.toFixed(1)}% (need < ${config.fvgClosePositionPercent}%)` };
  }

  // check volume confirmation (optional based on config)
  if (config.requireVolumeConfirmation && openingRangeAvgVolume) {
    const requiredVolume = openingRangeAvgVolume * config.volumeMultiplier;
    if (candle2.volume < requiredVolume) {
      logger.debug(`Bearish FVG rejected: Volume too low (${candle2.volume} < ${requiredVolume.toFixed(0)})`);
      return { detected: false, direction: null, candle1, candle2, candle3, details: `Volume too low: ${candle2.volume} (need ${requiredVolume.toFixed(0)})` };
    }
  }

  // check gap condition between candle 1 and candle 3
  const overlapThreshold = candle1.low * (1 + config.fvgOverlapTolerance / 100);
  if (candle3.high > overlapThreshold) {
    logger.debug(`Bearish FVG rejected: No gap detected (candle3.high ${candle3.high} > threshold ${overlapThreshold.toFixed(2)})`);
    return { detected: false, direction: null, candle1, candle2, candle3, details: `No gap: candle3.high ${candle3.high.toFixed(2)} > candle1.low ${candle1.low.toFixed(2)}` };
  }

  // all conditions met - bearish FVG detected
  const details = `Bearish FVG: Body=${bodyPercent2.toFixed(1)}%, Range=${rangePercent2.toFixed(2)}%, Close@${closePosition.toFixed(1)}%, Gap=${(candle1.low - candle3.high).toFixed(2)}`;
  logger.normal(`✓ BEARISH FVG DETECTED for ${symbol}: ${details}`);

  return { detected: true, direction: "BEARISH", candle1, candle2, candle3, details };
}

// ---- SIGNAL GENERATION ----

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

// ---- HELPER FUNCTIONS ----

// calculate average volume per minute from opening range candle (5-min candle / 5)
export function calculateOpeningRangeAvgVolume(
  openingRangeCandle: Candle,
): number {
  return openingRangeCandle.volume / 5;
}

// ---- OPENING RANGE STRENGTH SCORING ----

// score opening range strength based on multiple factors (0-10 scale)
// stronger opening ranges lead to more reliable breakout signals
export function scoreOpeningRangeStrength(
  openingRange: OpeningRange,
  openingCandle: Candle,
  config: Config,
): number {
  let score = 0;

  // factor 1: range size (ideal is mid-range, not too tight or too wide) - max 3 points
  const rangeSize = openingRange.size;
  const midpoint = (config.openingRangeMinSize + config.openingRangeMaxSize) / 2;
  const distanceFromMidpoint = Math.abs(rangeSize - midpoint);
  const maxDistance = config.openingRangeMaxSize - config.openingRangeMinSize;
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

// ---- PRE-MARKET GAP DETECTION ----

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

// check if pre-market gap is too large for our strategy
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
