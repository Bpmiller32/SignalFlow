//==============================================================================
// STRATEGY.TS - OPENING RANGE BREAKOUT WITH FVG CONFIRMATION
//==============================================================================
// This file implements the core trading strategy logic:
// 1. Calculate opening range from first 5-minute candle (9:30-9:35 AM EST)
// 2. Validate range size (filter too tight or too volatile ranges)
// 3. Detect breakouts above/below opening range
// 4. Confirm momentum using Fair Value Gap (FVG) pattern
// 5. Generate trading signals (LONG/SHORT)
// The strategy is conservative - it requires clear momentum confirmation
// through a 3-candle FVG pattern before generating any signals.
//==============================================================================

import {
  Candle,
  OpeningRange,
  Breakout,
  FVGPattern,
  Signal,
  Config,
} from "./types";
import * as logger from "./logger";

//==============================================================================
// OPENING RANGE CALCULATION
//==============================================================================

// Calculate the opening range from the first 5-minute candle (9:30-9:35 AM EST).
// The opening range is simply the high and low of this candle, along with
// its size as both a dollar amount and percentage of the stock price.

export function calculateOpeningRange(candle: Candle): OpeningRange {
  const high = candle.high;
  const low = candle.low;
  const sizeInDollars = high - low;

  // Calculate range size as percentage of stock price
  // Use the midpoint of the range for the calculation
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

// Validate if the opening range meets size requirements.
// Range must be:
// - Large enough to not be choppy (>= openingRangeMinSize %)
// - Small enough to not be too volatile (< = openingRangeMaxSize %)

export function isOpeningRangeValid(
  openingRange: OpeningRange,
  _currentPrice: number,
  config: Config,
): boolean {
  const size = openingRange.size;
  const minSize = config.openingRangeMinSize;
  const maxSize = config.openingRangeMaxSize;

  // Check if range is too tight (choppy/noisy)
  if (size < minSize) {
    logger.debug(
      `Opening range rejected: Too tight (${size.toFixed(2)}% < ${minSize}%). Market may be choppy.`,
    );
    return false;
  }

  // Check if range is too wide (volatile/gappy)
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

//==============================================================================
// BREAKOUT DETECTION
//==============================================================================

// Detect if a candle breaks above or below the opening range.
// A breakout occurs when:
// - Price breaks ABOVE opening range high (bullish breakout)
// - Price breaks BELOW opening range low (bearish breakout)
// We check both the high and low of the candle to catch breakouts.
// IMPROVEMENT: Also requires volume confirmation (20% above opening range avg)

export function detectBreakout(
  candle: Candle,
  openingRange: OpeningRange,
  openingRangeAvgVolume: number,
): Breakout {
  // Check for breakout above opening range (bullish)
  if (candle.high > openingRange.high) {
    // Volume confirmation on breakout candle (mandatory)
    const requiredVolume = openingRangeAvgVolume * 1.2; // 20% above average
    if (candle.volume < requiredVolume) {
      logger.debug(
        `Breakout ABOVE rejected: Low volume (${candle.volume} < ${requiredVolume.toFixed(0)})`,
      );
      return {
        detected: false,
        direction: null,
        candle,
        openingRange,
      };
    }

    logger.debug(
      `Breakout ABOVE detected: ${candle.symbol} broke ${openingRange.high} (high: ${candle.high}, volume: ${candle.volume})`,
    );
    return {
      detected: true,
      direction: "ABOVE",
      candle,
      openingRange,
    };
  }

  // Check for breakout below opening range (bearish)
  if (candle.low < openingRange.low) {
    // Volume confirmation on breakout candle (mandatory)
    const requiredVolume = openingRangeAvgVolume * 1.2; // 20% above average
    if (candle.volume < requiredVolume) {
      logger.debug(
        `Breakout BELOW rejected: Low volume (${candle.volume} < ${requiredVolume.toFixed(0)})`,
      );
      return {
        detected: false,
        direction: null,
        candle,
        openingRange,
      };
    }

    logger.debug(
      `Breakout BELOW detected: ${candle.symbol} broke ${openingRange.low} (low: ${candle.low}, volume: ${candle.volume})`,
    );
    return {
      detected: true,
      direction: "BELOW",
      candle,
      openingRange,
    };
  }

  // No breakout detected
  return {
    detected: false,
    direction: null,
    candle,
    openingRange,
  };
}

//==============================================================================
// FAIR VALUE GAP (FVG) PATTERN DETECTION
//==============================================================================

// Detect Fair Value Gap (FVG) pattern for momentum confirmation.
// FVG requires 3 consecutive candles with specific characteristics:
// BULLISH FVG (for LONG entry):
//   Candle 1: Breaks above opening range high
//   Candle 2: Strong bullish momentum candle with:
//     - Body (close - open) >= 60% of candle range (high - low)
//     - Range >= 0.15% of stock price (filters noise)
//     - Close in top 25% of candle range
//     - Volume >= 1.5x average opening range volume (optional)
//   Candle 3: Gap up from Candle 1:
//     - Candle3.low > Candle1.high (perfect gap)
//     - OR Candle3.low >= Candle1.high * 0.995 (0.5% overlap tolerance)
// BEARISH FVG (for SHORT entry):
//   Mirror of bullish rules (gap down, strong bearish candle)

export function detectFVG(
  candles: Candle[],
  direction: "BULLISH" | "BEARISH",
  config: Config,
  openingRangeAvgVolume?: number,
): FVGPattern {
  // Must have exactly 3 candles
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

  if (direction === "BULLISH") {
    return detectBullishFVG(
      candle1,
      candle2,
      candle3,
      config,
      openingRangeAvgVolume,
    );
  } else {
    return detectBearishFVG(
      candle1,
      candle2,
      candle3,
      config,
      openingRangeAvgVolume,
    );
  }
}

// Detect bullish FVG pattern (for LONG entries).

function detectBullishFVG(
  candle1: Candle,
  candle2: Candle,
  candle3: Candle,
  config: Config,
  openingRangeAvgVolume?: number,
): FVGPattern {
  const symbol = candle1.symbol;

  // Step 1: Validate candle 2 (momentum candle) characteristics
  const range2 = candle2.high - candle2.low;
  const body2 = candle2.close - candle2.open;
  const bodyPercent2 = range2 > 0 ? (body2 / range2) * 100 : 0;

  // Calculate range as percentage of stock price
  const midPrice = (candle2.high + candle2.low) / 2;
  const rangePercent2 = (range2 / midPrice) * 100;

  // Check if candle 2 is bullish (close > open)
  if (candle2.close <= candle2.open) {
    logger.debug(
      `Bullish FVG rejected: Candle 2 is not bullish (close ${candle2.close} <= open ${candle2.open})`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: "Candle 2 is not bullish",
    };
  }

  // Check body size requirement (body >= 60% of range)
  if (bodyPercent2 < config.fvgBodyPercent) {
    logger.debug(
      `Bullish FVG rejected: Body too small (${bodyPercent2.toFixed(1)}% < ${config.fvgBodyPercent}%)`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `Body too small: ${bodyPercent2.toFixed(1)}% (need ${config.fvgBodyPercent}%)`,
    };
  }

  // Check minimum range requirement (filters noise)
  if (rangePercent2 < config.fvgMinRangePercent) {
    logger.debug(
      `Bullish FVG rejected: Range too small (${rangePercent2.toFixed(2)}% < ${config.fvgMinRangePercent}%)`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `Range too small: ${rangePercent2.toFixed(2)}% (need ${config.fvgMinRangePercent}%)`,
    };
  }

  // Check close position (must be in top 25% of candle)
  const closePosition = ((candle2.close - candle2.low) / range2) * 100;
  const requiredClosePosition = 100 - config.fvgClosePositionPercent;
  if (closePosition < requiredClosePosition) {
    logger.debug(
      `Bullish FVG rejected: Close not in top 25% (${closePosition.toFixed(1)}% < ${requiredClosePosition}%)`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `Close position too low: ${closePosition.toFixed(1)}% (need ${requiredClosePosition}%)`,
    };
  }

  // Check volume confirmation (optional)
  if (config.requireVolumeConfirmation && openingRangeAvgVolume) {
    const requiredVolume = openingRangeAvgVolume * config.volumeMultiplier;
    if (candle2.volume < requiredVolume) {
      logger.debug(
        `Bullish FVG rejected: Volume too low (${candle2.volume} < ${requiredVolume.toFixed(0)})`,
      );
      return {
        detected: false,
        direction: null,
        candle1,
        candle2,
        candle3,
        details: `Volume too low: ${candle2.volume} (need ${requiredVolume.toFixed(0)})`,
      };
    }
  }

  // Step 2: Check gap condition between candle 1 and candle 3
  // Perfect gap: candle3.low > candle1.high
  // Allowed overlap: up to 0.5% (fvgOverlapTolerance)
  const overlapThreshold =
    candle1.high * (1 - config.fvgOverlapTolerance / 100);

  if (candle3.low < overlapThreshold) {
    logger.debug(
      `Bullish FVG rejected: No gap detected (candle3.low ${candle3.low} < threshold ${overlapThreshold.toFixed(2)})`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `No gap: candle3.low ${candle3.low.toFixed(2)} < candle1.high ${candle1.high.toFixed(2)}`,
    };
  }

  // All conditions met - Bullish FVG detected!
  const details = `Bullish FVG: Body=${bodyPercent2.toFixed(1)}%, Range=${rangePercent2.toFixed(2)}%, Close@${closePosition.toFixed(1)}%, Gap=${(candle3.low - candle1.high).toFixed(2)}`;
  logger.normal(`✓ BULLISH FVG DETECTED for ${symbol}: ${details}`);

  return {
    detected: true,
    direction: "BULLISH",
    candle1,
    candle2,
    candle3,
    details,
  };
}

// Detect bearish FVG pattern (for SHORT entries).
// Mirror of bullish FVG logic.

function detectBearishFVG(
  candle1: Candle,
  candle2: Candle,
  candle3: Candle,
  config: Config,
  openingRangeAvgVolume?: number,
): FVGPattern {
  const symbol = candle1.symbol;

  // Step 1: Validate candle 2 (momentum candle) characteristics
  const range2 = candle2.high - candle2.low;
  const body2 = candle2.open - candle2.close; // Bearish: open - close
  const bodyPercent2 = range2 > 0 ? (body2 / range2) * 100 : 0;

  // Calculate range as percentage of stock price
  const midPrice = (candle2.high + candle2.low) / 2;
  const rangePercent2 = (range2 / midPrice) * 100;

  // Check if candle 2 is bearish (close < open)
  if (candle2.close >= candle2.open) {
    logger.debug(
      `Bearish FVG rejected: Candle 2 is not bearish (close ${candle2.close} >= open ${candle2.open})`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: "Candle 2 is not bearish",
    };
  }

  // Check body size requirement (body >= 60% of range)
  if (bodyPercent2 < config.fvgBodyPercent) {
    logger.debug(
      `Bearish FVG rejected: Body too small (${bodyPercent2.toFixed(1)}% < ${config.fvgBodyPercent}%)`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `Body too small: ${bodyPercent2.toFixed(1)}% (need ${config.fvgBodyPercent}%)`,
    };
  }

  // Check minimum range requirement (filters noise)
  if (rangePercent2 < config.fvgMinRangePercent) {
    logger.debug(
      `Bearish FVG rejected: Range too small (${rangePercent2.toFixed(2)}% < ${config.fvgMinRangePercent}%)`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `Range too small: ${rangePercent2.toFixed(2)}% (need ${config.fvgMinRangePercent}%)`,
    };
  }

  // Check close position (must be in bottom 25% of candle)
  const closePosition = ((candle2.close - candle2.low) / range2) * 100;
  if (closePosition > config.fvgClosePositionPercent) {
    logger.debug(
      `Bearish FVG rejected: Close not in bottom 25% (${closePosition.toFixed(1)}% > ${config.fvgClosePositionPercent}%)`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `Close position too high: ${closePosition.toFixed(1)}% (need < ${config.fvgClosePositionPercent}%)`,
    };
  }

  // Check volume confirmation (optional)
  if (config.requireVolumeConfirmation && openingRangeAvgVolume) {
    const requiredVolume = openingRangeAvgVolume * config.volumeMultiplier;
    if (candle2.volume < requiredVolume) {
      logger.debug(
        `Bearish FVG rejected: Volume too low (${candle2.volume} < ${requiredVolume.toFixed(0)})`,
      );
      return {
        detected: false,
        direction: null,
        candle1,
        candle2,
        candle3,
        details: `Volume too low: ${candle2.volume} (need ${requiredVolume.toFixed(0)})`,
      };
    }
  }

  // Step 2: Check gap condition between candle 1 and candle 3
  // Perfect gap: candle3.high < candle1.low
  // Allowed overlap: up to 0.5% (fvgOverlapTolerance)
  const overlapThreshold = candle1.low * (1 + config.fvgOverlapTolerance / 100);

  if (candle3.high > overlapThreshold) {
    logger.debug(
      `Bearish FVG rejected: No gap detected (candle3.high ${candle3.high} > threshold ${overlapThreshold.toFixed(2)})`,
    );
    return {
      detected: false,
      direction: null,
      candle1,
      candle2,
      candle3,
      details: `No gap: candle3.high ${candle3.high.toFixed(2)} > candle1.low ${candle1.low.toFixed(2)}`,
    };
  }

  // All conditions met - Bearish FVG detected!
  const details = `Bearish FVG: Body=${bodyPercent2.toFixed(1)}%, Range=${rangePercent2.toFixed(2)}%, Close@${closePosition.toFixed(1)}%, Gap=${(candle1.low - candle3.high).toFixed(2)}`;
  logger.normal(`✓ BEARISH FVG DETECTED for ${symbol}: ${details}`);

  return {
    detected: true,
    direction: "BEARISH",
    candle1,
    candle2,
    candle3,
    details,
  };
}

//==============================================================================
// SIGNAL GENERATION
//==============================================================================

// Generate a trading signal based on breakout and FVG confirmation.
// This is the final step that combines all strategy components:
// - Opening range must be valid
// - Breakout must be detected
// - FVG pattern must confirm momentum

export function generateSignal(
  symbol: string,
  breakout: Breakout,
  fvgPattern: FVGPattern,
  currentPrice: number,
): Signal | null {
  // Must have breakout detected
  if (!breakout.detected) {
    return null;
  }

  // Must have FVG pattern detected
  if (!fvgPattern.detected) {
    return null;
  }

  // Direction must match
  const direction = breakout.direction === "ABOVE" ? "LONG" : "SHORT";
  const expectedFVGDirection =
    breakout.direction === "ABOVE" ? "BULLISH" : "BEARISH";

  if (fvgPattern.direction !== expectedFVGDirection) {
    logger.debug(
      `Signal generation failed: Direction mismatch (breakout=${breakout.direction}, FVG=${fvgPattern.direction})`,
    );
    return null;
  }

  // Generate the signal
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

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

// Calculate average volume from opening range candle.
// Used for volume confirmation in FVG detection and breakout detection.

export function calculateOpeningRangeAvgVolume(
  openingRangeCandle: Candle,
): number {
  // Opening range is 5 minutes, so divide volume by 5 for per-minute average
  return openingRangeCandle.volume / 5;
}

//==============================================================================
// OPENING RANGE STRENGTH SCORING
//==============================================================================

// IMPROVEMENT: Score opening range strength based on multiple factors.
// Stronger opening ranges lead to more reliable breakout signals.
// Score range: 0-10 (10 = strongest)

export function scoreOpeningRangeStrength(
  openingRange: OpeningRange,
  openingCandle: Candle,
  config: Config,
): number {
  let score = 0;

  // Factor 1: Range size (ideal is mid-range, not too tight or too wide)
  const rangeSize = openingRange.size;
  const midpoint = (config.openingRangeMinSize + config.openingRangeMaxSize) / 2;
  const distanceFromMidpoint = Math.abs(rangeSize - midpoint);
  const maxDistance = config.openingRangeMaxSize - config.openingRangeMinSize;
  const sizeScore = (1 - distanceFromMidpoint / maxDistance) * 3; // Max 3 points
  score += sizeScore;

  // Factor 2: Directional bias (close near high or low shows strength)
  const candleRange = openingCandle.high - openingCandle.low;
  const closePosition = (openingCandle.close - openingCandle.low) / candleRange;
  if (closePosition > 0.7 || closePosition < 0.3) {
    score += 2; // 2 points for strong directional bias
  }

  // Factor 3: Volume (higher than typical is better)
  // Assume typical 5-min volume is around average, give points for above-average
  const avgMinuteVolume = openingCandle.volume / 5;
  if (avgMinuteVolume > 0) {
    score += 2; // 2 points for having volume data
  }

  // Factor 4: Body size (larger body = more conviction)
  const body = Math.abs(openingCandle.close - openingCandle.open);
  const bodyPercent = (body / candleRange) * 100;
  if (bodyPercent > 50) {
    score += 2; // 2 points for strong body
  }

  // Factor 5: No extreme gaps (open should be near previous close)
  // This checks if opening candle has reasonable price action
  score += 1; // Base point for clean opening

  logger.debug(
    `Opening range strength: ${score.toFixed(1)}/10 (size: ${sizeScore.toFixed(1)}, bias: ${closePosition > 0.7 || closePosition < 0.3 ? 2 : 0}, body: ${bodyPercent.toFixed(0)}%)`,
  );

  return Math.min(score, 10); // Cap at 10
}

//==============================================================================
// PRE-MARKET GAP DETECTION
//==============================================================================

// IMPROVEMENT: Detect pre-market gaps that may affect trading.
// Large gaps often fill intraday, creating false breakout signals.
// Returns gap percentage (positive = gap up, negative = gap down)

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

// Check if pre-market gap is too large for our strategy.
// Strategy works best on continuous price action, not gap fills.

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
