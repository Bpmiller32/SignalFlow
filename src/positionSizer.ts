//==============================================================================
// POSITIONSIZER.TS - POSITION SIZE AND RISK CALCULATION
//==============================================================================
// This file calculates position sizes based on two modes:
// 1. FIXED: Trade a fixed dollar amount every time (simple and predictable)
// 2. RISK_BASED: Risk a fixed % of account on each trade (scales with account)
// Supports two stop loss calculation methods:
// 1. Opening Range-based: Stop below/above opening range (classic)
// 2. ATR-based: Stop at entry ± (ATR × multiplier) for volatility adaptation
// All position sizes respect MAX_POSITION_VALUE and MIN_POSITION_VALUE limits.
//==============================================================================

import { Config, OpeningRange, PositionSize, Signal, Candle } from "./types";
import * as logger from "./logger";

//==============================================================================
// ATR CALCULATION
//==============================================================================

// Calculate Average True Range (ATR) from recent candles.
// ATR measures market volatility and is used for adaptive stop placement.
// Formula:
//   True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
//   ATR = Simple Moving Average of True Ranges

export function calculateATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) {
    logger.debug(
      `Not enough candles for ATR: ${candles.length} < ${period + 1}`,
    );
    return 0;
  }

  const trueRanges: number[] = [];

  // Calculate True Range for each candle (need previous close)
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const range = current.high - current.low;
    const gapUp = Math.abs(current.high - previous.close);
    const gapDown = Math.abs(current.low - previous.close);

    const trueRange = Math.max(range, gapUp, gapDown);
    trueRanges.push(trueRange);
  }

  // Calculate simple moving average of last 'period' true ranges
  const recentTR = trueRanges.slice(-period);
  const atr = recentTR.reduce((sum, tr) => sum + tr, 0) / period;

  logger.debug(`ATR(${period}): ${atr.toFixed(2)}`);
  return atr;
}

//==============================================================================
// STOP LOSS AND TAKE PROFIT CALCULATION
//==============================================================================

// Calculate stop loss price based on configuration.
// Two modes supported:
// 1. Opening Range-based (classic): Stop below/above opening range with buffer
// 2. ATR-based (adaptive): Stop at entry ± (ATR × multiplier)
// ATR-based stops adapt to market volatility, while OR-based is simpler.

export function calculateStopLoss(
  signal: Signal,
  openingRange: OpeningRange,
  config: Config,
  recentCandles?: Candle[],
): number {
  // Use ATR-based stops if enabled and candles available
  if (config.useAtrStops && recentCandles && recentCandles.length > 0) {
    const atr = calculateATR(recentCandles, config.atrPeriod);

    if (atr > 0) {
      // ATR-based stop
      const stopDistance = atr * config.atrStopMultiplier;

      if (signal.direction === "LONG") {
        const stopPrice = signal.currentPrice - stopDistance;
        logger.normal(`Using ATR stops: ${stopPrice.toFixed(2)} (${atr.toFixed(2)} × ${config.atrStopMultiplier})`);
        logger.debug(
          `Stop loss (LONG, ATR-based): ${stopPrice.toFixed(2)} = Entry ${signal.currentPrice} - (ATR ${atr.toFixed(2)} × ${config.atrStopMultiplier})`,
        );
        return stopPrice;
      } else {
        const stopPrice = signal.currentPrice + stopDistance;
        logger.normal(`Using ATR stops: ${stopPrice.toFixed(2)} (${atr.toFixed(2)} × ${config.atrStopMultiplier})`);
        logger.debug(
          `Stop loss (SHORT, ATR-based): ${stopPrice.toFixed(2)} = Entry ${signal.currentPrice} + (ATR ${atr.toFixed(2)} × ${config.atrStopMultiplier})`,
        );
        return stopPrice;
      }
    } else {
      logger.normal("ATR stops unavailable - using opening range stops (fallback)");
      logger.debug(
        "ATR calculation failed, falling back to opening range stops",
      );
    }
  }

  // Fall back to opening range-based stops
  logger.normal("Using opening range stops");
  if (signal.direction === "LONG") {
    // For longs, stop below the opening range low
    const stopPrice =
      openingRange.low * (1 - config.stopLossBufferPercent / 100);
    logger.debug(
      `Stop loss (LONG, OR-based): ${stopPrice.toFixed(2)} = OR Low ${openingRange.low} - ${config.stopLossBufferPercent}% buffer`,
    );
    return stopPrice;
  } else {
    // For shorts, stop above the opening range high
    const stopPrice =
      openingRange.high * (1 + config.stopLossBufferPercent / 100);
    logger.debug(
      `Stop loss (SHORT, OR-based): ${stopPrice.toFixed(2)} = OR High ${openingRange.high} + ${config.stopLossBufferPercent}% buffer`,
    );
    return stopPrice;
  }
}

// Calculate take profit price based on entry, stop, and risk/reward ratio.
// Formula:
//   Risk = |Entry - Stop|
//   Reward = Risk × Risk/Reward Ratio
//   Target = Entry + Reward (for LONG) or Entry - Reward (for SHORT)
// Default is 2:1 risk/reward ratio.

export function calculateTakeProfit(
  entryPrice: number,
  stopPrice: number,
  direction: "LONG" | "SHORT",
  config: Config,
): number {
  // Calculate risk per share
  const riskPerShare = Math.abs(entryPrice - stopPrice);

  // Calculate reward per share (risk × ratio)
  const rewardPerShare = riskPerShare * config.riskRewardRatio;

  // Calculate target price
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

//==============================================================================
// POSITION SIZING - FIXED MODE
//==============================================================================

// Calculate position size using FIXED mode.
// In FIXED mode, we always trade a fixed dollar amount regardless of account size.
// This is simple and predictable.
// Formula:
//   Quantity = Fixed Dollar Amount / Entry Price

export function calculateFixedPositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  config: Config,
  recentCandles?: Candle[],
): PositionSize | null {
  const entryPrice = signal.currentPrice;
  const stopPrice = calculateStopLoss(signal, openingRange, config, recentCandles);
  const targetPrice = calculateTakeProfit(
    entryPrice,
    stopPrice,
    signal.direction,
    config,
  );

  // EDGE CASE FIX: Validate stop and target are on correct side of entry
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
    // SHORT
    if (stopPrice <= entryPrice) {
      logger.error(`Invalid SHORT stop: ${stopPrice} <= entry ${entryPrice}`);
      return null;
    }
    if (targetPrice >= entryPrice) {
      logger.error(`Invalid SHORT target: ${targetPrice} >= entry ${entryPrice}`);
      return null;
    }
  }

  // Calculate quantity based on fixed dollar amount
  const dollarValue = config.fixedPositionSize;
  const quantity = Math.floor(dollarValue / entryPrice);

  // Check if quantity is at least 1 share
  if (quantity < 1) {
    logger.normal(
      `Position size too small: Fixed ${dollarValue} / Entry ${entryPrice} = ${quantity} shares (need at least 1)`,
    );
    return null;
  }

  // Recalculate actual dollar value based on whole shares
  const actualDollarValue = quantity * entryPrice;

  // Check against max position value
  if (actualDollarValue > config.maxPositionValue) {
    logger.normal(
      `Position size exceeds max: ${actualDollarValue.toFixed(2)} > ${config.maxPositionValue}`,
    );
    return null;
  }

  // Check against min position value
  if (actualDollarValue < config.minPositionValue) {
    logger.normal(
      `Position size below min: ${actualDollarValue.toFixed(2)} < ${config.minPositionValue}`,
    );
    return null;
  }

  // Calculate risk and reward
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

//==============================================================================
// POSITION SIZING - RISK BASED MODE
//==============================================================================

// Calculate position size using RISK_BASED mode.
// In RISK_BASED mode, we risk a fixed percentage of the account on each trade.
// This scales position size with account growth/drawdown.
// Formula:
//   Risk Amount = Account Value × Risk %
//   Risk Per Share = |Entry - Stop|
//   Quantity = Risk Amount / Risk Per Share

export function calculateRiskBasedPositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  accountValue: number,
  config: Config,
  recentCandles?: Candle[],
): PositionSize | null {
  const entryPrice = signal.currentPrice;
  const stopPrice = calculateStopLoss(signal, openingRange, config, recentCandles);
  const targetPrice = calculateTakeProfit(
    entryPrice,
    stopPrice,
    signal.direction,
    config,
  );

  // EDGE CASE FIX: Validate stop and target are on correct side of entry
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
    // SHORT
    if (stopPrice <= entryPrice) {
      logger.error(`Invalid SHORT stop: ${stopPrice} <= entry ${entryPrice}`);
      return null;
    }
    if (targetPrice >= entryPrice) {
      logger.error(`Invalid SHORT target: ${targetPrice} >= entry ${entryPrice}`);
      return null;
    }
  }

  // Calculate risk per share
  const riskPerShare = Math.abs(entryPrice - stopPrice);

  // Calculate total risk amount (% of account)
  const totalRiskAmount = accountValue * (config.accountRiskPercent / 100);

  // Calculate quantity based on risk
  const quantity = Math.floor(totalRiskAmount / riskPerShare);

  // Check if quantity is at least 1 share
  if (quantity < 1) {
    logger.normal(
      `Position size too small: Risk ${totalRiskAmount.toFixed(2)} / Risk/Share ${riskPerShare.toFixed(2)} = ${quantity} shares (need at least 1)`,
    );
    return null;
  }

  // Calculate actual dollar value
  const actualDollarValue = quantity * entryPrice;

  // Check against max position value
  if (actualDollarValue > config.maxPositionValue) {
    // Reduce quantity to respect max position value
    const maxQuantity = Math.floor(config.maxPositionValue / entryPrice);
    if (maxQuantity < 1) {
      logger.normal(
        `Cannot size position: Max position value ${config.maxPositionValue} / Entry ${entryPrice} = ${maxQuantity} shares`,
      );
      return null;
    }

    logger.debug(
      `Position capped at max value: ${quantity} shares reduced to ${maxQuantity} shares`,
    );

    // Recalculate with capped quantity
    return calculateWithQuantity(
      signal,
      openingRange,
      maxQuantity,
      entryPrice,
      stopPrice,
      targetPrice,
      config,
    );
  }

  // Check against min position value
  if (actualDollarValue < config.minPositionValue) {
    logger.normal(
      `Position size below min: ${actualDollarValue.toFixed(2)} < ${config.minPositionValue}`,
    );
    return null;
  }

  // Calculate actual risk and reward with final quantity
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

// Helper function to calculate position size with a specific quantity.
// Used when we need to cap position size at max value.

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

//==============================================================================
// MAIN POSITION SIZING FUNCTION
//==============================================================================

// Calculate position size based on configured mode (FIXED or RISK_BASED).
// This is the main function that should be called by the trading system.
// It delegates to the appropriate sizing function based on config.

export function calculatePositionSize(
  signal: Signal,
  openingRange: OpeningRange,
  accountValue: number,
  config: Config,
  recentCandles?: Candle[],
): PositionSize | null {
  logger.debug(
    `Calculating position size for ${signal.direction} ${signal.symbol} | Mode: ${config.positionSizeMode}`,
  );

  if (config.positionSizeMode === "FIXED") {
    return calculateFixedPositionSize(signal, openingRange, config, recentCandles);
  } else {
    return calculateRiskBasedPositionSize(
      signal,
      openingRange,
      accountValue,
      config,
      recentCandles,
    );
  }
}

//==============================================================================
// POSITION SIZE VALIDATION
//==============================================================================

// Validate that a position size meets all requirements.
// Checks:
// - Quantity is at least 1 share
// - Dollar value is within min/max limits
// - Stop and target prices are valid

export function validatePositionSize(
  positionSize: PositionSize,
  config: Config,
): boolean {
  // Check quantity
  if (positionSize.quantity < 1) {
    logger.debug(
      `Invalid position size: Quantity ${positionSize.quantity} < 1`,
    );
    return false;
  }

  // Check dollar value against max
  if (positionSize.dollarValue > config.maxPositionValue) {
    logger.debug(
      `Invalid position size: Value ${positionSize.dollarValue} > max ${config.maxPositionValue}`,
    );
    return false;
  }

  // Check dollar value against min
  if (positionSize.dollarValue < config.minPositionValue) {
    logger.debug(
      `Invalid position size: Value ${positionSize.dollarValue} < min ${config.minPositionValue}`,
    );
    return false;
  }

  // Check that stop and target are on correct side of entry
  if (positionSize.entryPrice === positionSize.stopPrice) {
    logger.debug(
      `Invalid position size: Entry equals stop price ${positionSize.entryPrice}`,
    );
    return false;
  }

  if (positionSize.entryPrice === positionSize.targetPrice) {
    logger.debug(
      `Invalid position size: Entry equals target price ${positionSize.entryPrice}`,
    );
    return false;
  }

  // All checks passed
  return true;
}
