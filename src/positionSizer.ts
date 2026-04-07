// positionSizer.ts - Position size and risk calculation
// Two sizing modes: FIXED (fixed dollar amount) and RISK_BASED (% of account).
// Two stop loss methods: Opening Range-based (classic) and ATR-based (adaptive).
// All position sizes respect MAX_POSITION_VALUE and MIN_POSITION_VALUE limits.

import { Config, OpeningRange, PositionSize, Signal, Candle } from "./types";
import * as logger from "./logger";

// ---- ATR CALCULATION ----

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

// ---- STOP LOSS AND TAKE PROFIT CALCULATION ----

// calculate stop loss price based on configuration
// ATR-based stops adapt to volatility, OR-based is simpler
export function calculateStopLoss(
  signal: Signal,
  openingRange: OpeningRange,
  config: Config,
  recentCandles?: Candle[],
): number {
  // try ATR-based stops if enabled and candles available
  if (config.useAtrStops && recentCandles && recentCandles.length > 0) {
    const atr = calculateATR(recentCandles, config.atrPeriod);

    if (atr > 0) {
      // stop distance = ATR * multiplier
      const stopDistance = atr * config.atrStopMultiplier;

      if (signal.direction === "LONG") {
        const stopPrice = signal.currentPrice - stopDistance;
        logger.normal(`Using ATR stops: ${stopPrice.toFixed(2)} (${atr.toFixed(2)} × ${config.atrStopMultiplier})`);
        return stopPrice;
      } else {
        const stopPrice = signal.currentPrice + stopDistance;
        logger.normal(`Using ATR stops: ${stopPrice.toFixed(2)} (${atr.toFixed(2)} × ${config.atrStopMultiplier})`);
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
    const stopPrice = openingRange.low * (1 - config.stopLossBufferPercent / 100);
    logger.debug(`Stop loss (LONG, OR-based): ${stopPrice.toFixed(2)} = OR Low ${openingRange.low} - ${config.stopLossBufferPercent}% buffer`);
    return stopPrice;
  } else {
    // for shorts, stop above the opening range high with buffer
    const stopPrice = openingRange.high * (1 + config.stopLossBufferPercent / 100);
    logger.debug(`Stop loss (SHORT, OR-based): ${stopPrice.toFixed(2)} = OR High ${openingRange.high} + ${config.stopLossBufferPercent}% buffer`);
    return stopPrice;
  }
}

// calculate take profit price from entry, stop, and risk/reward ratio
export function calculateTakeProfit(
  entryPrice: number,
  stopPrice: number,
  direction: "LONG" | "SHORT",
  config: Config,
): number {
  // risk per share = distance from entry to stop
  const riskPerShare = Math.abs(entryPrice - stopPrice);

  // reward per share = risk * risk/reward ratio
  const rewardPerShare = riskPerShare * config.riskRewardRatio;

  // target price = entry +/- reward
  let targetPrice: number;
  if (direction === "LONG") {
    targetPrice = entryPrice + rewardPerShare;
  } else {
    targetPrice = entryPrice - rewardPerShare;
  }

  logger.debug(
    `Take profit (${direction}): ${targetPrice.toFixed(2)} = Entry ${entryPrice} ${direction === "LONG" ? "+" : "-"} ${rewardPerShare.toFixed(2)} (${config.riskRewardRatio}:1 R/R)`,
  );

  return targetPrice;
}

// ---- POSITION SIZING - FIXED MODE ----

// calculate position size using FIXED mode (always trade a fixed dollar amount)
export function calculateFixedPositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  config: Config,
  recentCandles?: Candle[],
): PositionSize | null {
  const entryPrice = signal.currentPrice;
  const stopPrice = calculateStopLoss(signal, openingRange, config, recentCandles);
  const targetPrice = calculateTakeProfit(entryPrice, stopPrice, signal.direction, config);

  // validate stop and target are on correct side of entry
  if (signal.direction === "LONG") {
    if (stopPrice >= entryPrice) {
      logger.error(`Invalid LONG stop: ${stopPrice} >= entry ${entryPrice}`);
      return null;
    }
    if (targetPrice <= entryPrice) {
      logger.error(`Invalid LONG target: ${targetPrice} <= entry ${entryPrice}`);
      return null;
    }
  } else {
    if (stopPrice <= entryPrice) {
      logger.error(`Invalid SHORT stop: ${stopPrice} <= entry ${entryPrice}`);
      return null;
    }
    if (targetPrice >= entryPrice) {
      logger.error(`Invalid SHORT target: ${targetPrice} >= entry ${entryPrice}`);
      return null;
    }
  }

  // calculate quantity from fixed dollar amount
  const dollarValue = config.fixedPositionSize;
  const quantity = Math.floor(dollarValue / entryPrice);

  // need at least 1 share
  if (quantity < 1) {
    logger.normal(`Position size too small: Fixed ${dollarValue} / Entry ${entryPrice} = ${quantity} shares (need at least 1)`);
    return null;
  }

  // recalculate actual dollar value based on whole shares
  const actualDollarValue = quantity * entryPrice;

  // check against max position value
  if (actualDollarValue > config.maxPositionValue) {
    logger.normal(`Position size exceeds max: ${actualDollarValue.toFixed(2)} > ${config.maxPositionValue}`);
    return null;
  }

  // check against min position value
  if (actualDollarValue < config.minPositionValue) {
    logger.normal(`Position size below min: ${actualDollarValue.toFixed(2)} < ${config.minPositionValue}`);
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
    riskRewardRatio: config.riskRewardRatio,
  };
}

// ---- POSITION SIZING - RISK BASED MODE ----

// calculate position size using RISK_BASED mode (risk a fixed % of account)
export function calculateRiskBasedPositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  accountValue: number,
  config: Config,
  recentCandles?: Candle[],
): PositionSize | null {
  const entryPrice = signal.currentPrice;
  const stopPrice = calculateStopLoss(signal, openingRange, config, recentCandles);
  const targetPrice = calculateTakeProfit(entryPrice, stopPrice, signal.direction, config);

  // validate stop and target are on correct side of entry
  if (signal.direction === "LONG") {
    if (stopPrice >= entryPrice) {
      logger.error(`Invalid LONG stop: ${stopPrice} >= entry ${entryPrice}`);
      return null;
    }
    if (targetPrice <= entryPrice) {
      logger.error(`Invalid LONG target: ${targetPrice} <= entry ${entryPrice}`);
      return null;
    }
  } else {
    if (stopPrice <= entryPrice) {
      logger.error(`Invalid SHORT stop: ${stopPrice} <= entry ${entryPrice}`);
      return null;
    }
    if (targetPrice >= entryPrice) {
      logger.error(`Invalid SHORT target: ${targetPrice} >= entry ${entryPrice}`);
      return null;
    }
  }

  // calculate risk per share and total risk amount
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const totalRiskAmount = accountValue * (config.accountRiskPercent / 100);

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
  if (actualDollarValue > config.maxPositionValue) {
    const maxQuantity = Math.floor(config.maxPositionValue / entryPrice);
    if (maxQuantity < 1) {
      logger.normal(`Cannot size position: Max position value ${config.maxPositionValue} / Entry ${entryPrice} = ${maxQuantity} shares`);
      return null;
    }

    logger.debug(`Position capped at max value: ${quantity} shares reduced to ${maxQuantity} shares`);

    // recalculate with capped quantity
    return calculateWithQuantity(signal, openingRange, maxQuantity, entryPrice, stopPrice, targetPrice, config);
  }

  // check against min position value
  if (actualDollarValue < config.minPositionValue) {
    logger.normal(`Position size below min: ${actualDollarValue.toFixed(2)} < ${config.minPositionValue}`);
    return null;
  }

  // calculate actual risk and reward with final quantity
  const actualTotalRisk = riskPerShare * quantity;
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const potentialProfit = rewardPerShare * quantity;

  logger.normal(
    `Position sized (RISK_BASED): ${quantity} shares @ ${entryPrice.toFixed(2)} = $${actualDollarValue.toFixed(2)} | Risk: $${actualTotalRisk.toFixed(2)} (${config.accountRiskPercent}% of ${accountValue.toFixed(2)}) | Reward: $${potentialProfit.toFixed(2)}`,
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
    riskRewardRatio: config.riskRewardRatio,
  };
}

// helper to calculate position size with a specific quantity (used when capping at max value)
function calculateWithQuantity(
  signal: Signal,
  _openingRange: OpeningRange,
  quantity: number,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
  config: Config,
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
    riskRewardRatio: config.riskRewardRatio,
  };
}

// ---- MAIN POSITION SIZING FUNCTION ----

// calculate position size based on configured mode (FIXED or RISK_BASED)
export function calculatePositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  accountValue: number,
  config: Config,
  recentCandles?: Candle[],
): PositionSize | null {
  logger.debug(`Calculating position size for ${signal.direction} ${signal.symbol} | Mode: ${config.positionSizeMode}`);

  if (config.positionSizeMode === "FIXED") {
    return calculateFixedPositionSize(signal, openingRange, config, recentCandles);
  } else {
    return calculateRiskBasedPositionSize(signal, openingRange, accountValue, config, recentCandles);
  }
}

// ---- POSITION SIZE VALIDATION ----

// validate that a position size meets all requirements
export function validatePositionSize(
  positionSize: PositionSize,
  config: Config,
): boolean {
  // check quantity
  if (positionSize.quantity < 1) {
    logger.debug(`Invalid position size: Quantity ${positionSize.quantity} < 1`);
    return false;
  }

  // check dollar value against max
  if (positionSize.dollarValue > config.maxPositionValue) {
    logger.debug(`Invalid position size: Value ${positionSize.dollarValue} > max ${config.maxPositionValue}`);
    return false;
  }

  // check dollar value against min
  if (positionSize.dollarValue < config.minPositionValue) {
    logger.debug(`Invalid position size: Value ${positionSize.dollarValue} < min ${config.minPositionValue}`);
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
