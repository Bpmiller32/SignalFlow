//==============================================================================
// FILTERS.TS - TRADING FILTERS AND QUALITY CHECKS
//==============================================================================
// This file contains filter functions that improve trade quality:
// - Signal quality grading (strong vs weak setups)
// - Opening range strength adjustment (position sizing based on OR quality)
//==============================================================================

import { Config, FVGPattern } from "./types";
import * as logger from "./logger";

//==============================================================================
// SIGNAL QUALITY GRADING
//==============================================================================
// Grade each signal as STRONG or WEAK based on how well it meets criteria
// Why: Strong signals deserve full size, weak signals deserve reduced size

export function gradeSignalQuality(
  fvgPattern: FVGPattern,
  config: Config,
): "STRONG" | "WEAK" {
  // Start with assumption it's strong (it already passed basic FVG requirements)
  let qualityScore = 0;

  // Parse FVG pattern details to extract metrics
  // Details format: "Bullish FVG: Body=XX%, Range=XX%, Close@XX%, Gap=XX"

  const details = fvgPattern.details;

  // Extract body percentage
  const bodyMatch = details.match(/Body=(\d+\.?\d*)%/);
  if (bodyMatch) {
    const bodyPercent = parseFloat(bodyMatch[1]);
    // If body is significantly above minimum (10% buffer), it's stronger
    if (bodyPercent >= config.fvgBodyPercent + 10) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Strong body (${bodyPercent}% vs ${config.fvgBodyPercent}% min)`,
      );
    }
  }

  // Extract range percentage
  const rangeMatch = details.match(/Range=(\d+\.?\d*)%/);
  if (rangeMatch) {
    const rangePercent = parseFloat(rangeMatch[1]);
    // If range is significantly above minimum (0.1% buffer), it's stronger
    if (rangePercent >= config.fvgMinRangePercent + 0.1) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Strong range (${rangePercent}% vs ${config.fvgMinRangePercent}% min)`,
      );
    }
  }

  // Extract close position
  const closeMatch = details.match(/Close@(\d+\.?\d*)%/);
  if (closeMatch) {
    const closePosition = parseFloat(closeMatch[1]);
    // For bullish, close should be high (>85%). For bearish, close should be low (<15%)
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

  // Extract gap size
  const gapMatch = details.match(/Gap=(\d+\.?\d*)/);
  if (gapMatch) {
    const gapSize = parseFloat(gapMatch[1]);
    // If gap is large (>$0.50 for stocks >$100), it's stronger
    const candle2Price = fvgPattern.candle2.close;
    const gapPercent = (gapSize / candle2Price) * 100;
    if (gapPercent > 0.3) {
      // >0.3% gap
      qualityScore++;
      logger.debug(
        `Signal quality +1: Large gap (${gapPercent.toFixed(2)}%)`,
      );
    }
  }

  // Grade: 3+ quality points = STRONG, <3 = WEAK
  const grade = qualityScore >= 3 ? "STRONG" : "WEAK";
  logger.normal(
    `Signal graded as ${grade} (quality score: ${qualityScore}/4)`,
  );

  return grade;
}

//==============================================================================
// OPENING RANGE STRENGTH ADJUSTMENT
//==============================================================================
// Adjust position size based on opening range strength score (0-10).
// Strong setups (8-10) = full size (1.0x)
// Medium setups (5-7) = reduced size (0.75x)
// Weak setups (<5) = rejected (returns 0)

export function adjustSizeForOpeningRangeStrength(
  strengthScore: number,
): number {
  if (strengthScore < 5) {
    logger.debug(`OR strength too weak: ${strengthScore.toFixed(1)}/10 - rejecting`);
    return 0; // Reject
  }
  if (strengthScore < 8) {
    logger.debug(`OR strength medium: ${strengthScore.toFixed(1)}/10 - reducing size to 75%`);
    return 0.75; // Reduce size
  }
  logger.debug(`OR strength strong: ${strengthScore.toFixed(1)}/10 - full size`);
  return 1.0; // Full size
}

