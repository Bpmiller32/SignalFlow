// filters.ts - Trading filters and quality checks
// Signal quality grading (strong vs weak setups) and opening range
// strength adjustment (position sizing based on OR quality).

import { Config, FVGPattern } from "./types";
import * as logger from "./logger";

// ---- SIGNAL QUALITY GRADING ----
// grade each signal as STRONG or WEAK based on how well it meets criteria
// strong signals get full size, weak signals get reduced size

// grade signal quality by parsing FVG pattern details
export function gradeSignalQuality(
  fvgPattern: FVGPattern,
  config: Config,
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
    if (bodyPercent >= config.fvgBodyPercent + 10) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Strong body (${bodyPercent}% vs ${config.fvgBodyPercent}% min)`,
      );
    }
  }

  // extract range percentage from details string
  const rangeMatch = details.match(/Range=(\d+\.?\d*)%/);
  if (rangeMatch) {
    const rangePercent = parseFloat(rangeMatch[1]);
    // if range is significantly above minimum (0.1% buffer), it's stronger
    if (rangePercent >= config.fvgMinRangePercent + 0.1) {
      qualityScore++;
      logger.debug(
        `Signal quality +1: Strong range (${rangePercent}% vs ${config.fvgMinRangePercent}% min)`,
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

// ---- OPENING RANGE STRENGTH ADJUSTMENT ----
// adjust position size based on opening range strength score (0-10)
// strong (8-10) = full size, medium (5-7) = 75%, weak (<5) = rejected

// return a multiplier for position size based on opening range strength
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
