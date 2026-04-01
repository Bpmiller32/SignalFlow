//==============================================================================
// PAPERBROKER.TS - SIMULATED TRADING FOR TESTING
//==============================================================================
// This file implements a paper trading simulator that mimics real broker
// behavior without using real money. It's used for testing the strategy
// before going live.
// Features:
// - Simulated order execution (market orders)
// - Simulated position tracking
// - Simulated stop loss and take profit orders
// - Trailing stop support (moves stop as price moves favorably)
// - Partial exit support (take profit on portion, trail remainder)
// - Simulated P&L calculation
// - Account balance tracking
// Orders are filled immediately at current market price (no slippage simulation).
// Stop and target orders are checked against each incoming candle.
//==============================================================================

import {
  Order,
  OrderResult,
  Position,
  PositionSize,
  Candle,
  AccountInfo,
} from "./types";
import * as logger from "./logger";

//==============================================================================
// PAPER BROKER STATE
//==============================================================================

// In-memory state for paper trading
interface PaperBrokerState {
  accountEquity: number;
  accountCash: number;
  positions: Map<string, Position>; // symbol -> position
  orderIdCounter: number; // Counter for generating order IDs
  tradeHistory: Array<{
    symbol: string;
    action: string;
    quantity: number;
    price: number;
    timestamp: Date;
  }>;
}

// Initialize paper broker with starting balance
let state: PaperBrokerState = {
  accountEquity: 100000, // Start with $100k
  accountCash: 100000,
  positions: new Map(),
  orderIdCounter: 1,
  tradeHistory: [],
};

//==============================================================================
// INITIALIZATION
//==============================================================================

// Initialize paper broker with a starting balance.
// This should be called once at startup before any trading.

export function initializePaperBroker(startingBalance: number): void {
  state = {
    accountEquity: startingBalance,
    accountCash: startingBalance,
    positions: new Map(),
    orderIdCounter: 1,
    tradeHistory: [],
  };
  logger.normal(`Paper broker initialized with $${startingBalance.toFixed(2)}`);
}

// Get current account information.

export function getAccountInfo(): AccountInfo {
  // Calculate total equity (cash + position values)
  let positionValue = 0;
  const positionsArray: Position[] = [];

  state.positions.forEach((position) => {
    // Position value = quantity × current price (we'll use entry price as approximation)
    positionValue += position.quantity * position.entryPrice;
    positionsArray.push(position);
  });

  const totalEquity = state.accountCash + positionValue;

  return {
    equity: totalEquity,
    cash: state.accountCash,
    buyingPower: state.accountCash, // For simplicity, buying power = cash (no margin)
    dayTradeCount: 0, // Not tracked in paper trading
    positions: positionsArray,
  };
}

//==============================================================================
// ORDER PLACEMENT
//==============================================================================

// Place a market order (buy or sell).
// In paper trading, market orders are filled immediately at the current price.

export function placeMarketOrder(
  order: Order,
  currentPrice: number,
): OrderResult {
  // Generate order ID
  const orderId = `PAPER-${state.orderIdCounter++}`;

  // Calculate total cost/proceeds
  const dollarAmount = order.quantity * currentPrice;

  // Check if we have enough cash for BUY orders
  if (order.side === "BUY") {
    if (dollarAmount > state.accountCash) {
      logger.error(
        `Insufficient cash for order: Need $${dollarAmount.toFixed(2)}, have $${state.accountCash.toFixed(2)}`,
      );
      return {
        success: false,
        orderId: "",
        error: "Insufficient buying power",
      };
    }

    // Deduct cash
    state.accountCash -= dollarAmount;
  } else {
    // SELL order - add cash
    state.accountCash += dollarAmount;
  }

  // Record trade
  state.tradeHistory.push({
    symbol: order.symbol,
    action: order.side,
    quantity: order.quantity,
    price: currentPrice,
    timestamp: new Date(),
  });

  logger.normal(
    `Paper order filled: ${order.side} ${order.quantity} ${order.symbol} @ $${currentPrice.toFixed(2)} | Order ID: ${orderId}`,
  );

  return {
    success: true,
    orderId,
    filledPrice: currentPrice,
    filledQuantity: order.quantity,
  };
}

// Open a new position with entry, stop loss, and take profit orders.
// This is the main function for entering trades.

export function openPosition(positionSize: PositionSize): Position | null {
  const symbol = positionSize.symbol;

  // Check if we already have a position in this symbol
  if (state.positions.has(symbol)) {
    logger.error(`Cannot open position: Already have position in ${symbol}`);
    return null;
  }

  // Determine order side based on direction
  const side =
    positionSize.entryPrice < positionSize.targetPrice ? "LONG" : "SHORT";
  const orderSide = side === "LONG" ? "BUY" : "SELL";

  // Create entry order
  const entryOrder: Order = {
    symbol,
    side: orderSide,
    quantity: positionSize.quantity,
    type: "MARKET",
    timeInForce: "DAY",
  };

  // Execute entry order
  const entryResult = placeMarketOrder(entryOrder, positionSize.entryPrice);

  if (!entryResult.success) {
    return null;
  }

  // Create position object with trailing stop and partial exit tracking
  const position: Position = {
    symbol,
    side,
    entryPrice: positionSize.entryPrice,
    quantity: positionSize.quantity,
    entryTime: new Date(),
    stopLoss: positionSize.stopPrice,
    takeProfit: positionSize.targetPrice,
    orderIds: {
      entry: entryResult.orderId,
      stopLoss: `PAPER-SL-${state.orderIdCounter++}`, // Simulated stop order
      takeProfit: `PAPER-TP-${state.orderIdCounter++}`, // Simulated target order
    },
    // Trailing stop initialization
    initialStopLoss: positionSize.stopPrice,
    highestPrice: side === "LONG" ? positionSize.entryPrice : undefined,
    lowestPrice: side === "SHORT" ? positionSize.entryPrice : undefined,
    trailingStopActive: false,
    // Partial exit initialization
    originalQuantity: positionSize.quantity,
    partialExitExecuted: false,
  };

  // Store position
  state.positions.set(symbol, position);

  logger.normal(
    `Position opened: ${side} ${positionSize.quantity} ${symbol} @ $${positionSize.entryPrice.toFixed(2)} | Stop: $${positionSize.stopPrice.toFixed(2)} | Target: $${positionSize.targetPrice.toFixed(2)}`,
  );

  return position;
}

//==============================================================================
// POSITION MONITORING
//==============================================================================

// Update trailing stop for a position based on current price.
// Trailing stops move the stop loss up (for longs) or down (for shorts)
// as the price moves favorably, locking in profits while giving room to run.

export function updateTrailingStop(
  position: Position,
  currentHigh: number,
  currentLow: number,
  trailingDistance: number,
): void {
  if (!position.trailingStopActive) {
    return; // Trailing not active yet
  }

  if (position.side === "LONG") {
    // Update highest price seen
    if (currentHigh > (position.highestPrice || position.entryPrice)) {
      position.highestPrice = currentHigh;

      // Calculate new trailing stop
      const newStop = currentHigh - trailingDistance;

      // Only move stop up, never down
      if (newStop > position.stopLoss) {
        logger.debug(
          `Trailing stop updated (LONG): ${position.symbol} stop moved from ${position.stopLoss.toFixed(2)} to ${newStop.toFixed(2)}`,
        );
        position.stopLoss = newStop;
      }
    }
  } else {
    // SHORT position
    // Update lowest price seen
    if (currentLow < (position.lowestPrice || position.entryPrice)) {
      position.lowestPrice = currentLow;

      // Calculate new trailing stop
      const newStop = currentLow + trailingDistance;

      // Only move stop down, never up
      if (newStop < position.stopLoss) {
        logger.debug(
          `Trailing stop updated (SHORT): ${position.symbol} stop moved from ${position.stopLoss.toFixed(2)} to ${newStop.toFixed(2)}`,
        );
        position.stopLoss = newStop;
      }
    }
  }
}

// Execute partial exit on a position.
// Closes a percentage of the position and adjusts the remaining quantity.
// Returns the P&L from the partial exit.

export function executePartialExit(
  position: Position,
  exitPrice: number,
  exitPercent: number,
): number {
  if (position.partialExitExecuted) {
    logger.debug(
      `Partial exit already executed for ${position.symbol}, skipping`,
    );
    return 0;
  }

  // Calculate quantity to exit
  const exitQuantity = Math.floor(
    position.originalQuantity * (exitPercent / 100),
  );

  if (exitQuantity < 1) {
    logger.debug(
      `Partial exit quantity too small: ${exitQuantity} shares, skipping`,
    );
    return 0;
  }

  // Calculate P&L on partial exit
  let pnl: number;
  if (position.side === "LONG") {
    pnl = (exitPrice - position.entryPrice) * exitQuantity;
  } else {
    pnl = (position.entryPrice - exitPrice) * exitQuantity;
  }

  // Execute the partial exit order
  const closeSide = position.side === "LONG" ? "SELL" : "BUY";
  const closeOrder: Order = {
    symbol: position.symbol,
    side: closeSide,
    quantity: exitQuantity,
    type: "MARKET",
    timeInForce: "DAY",
  };

  placeMarketOrder(closeOrder, exitPrice);

  // Update position
  position.quantity -= exitQuantity;
  position.partialExitExecuted = true;

  logger.normal(
    `Partial exit executed: ${position.symbol} closed ${exitQuantity}/${position.originalQuantity} shares @ ${exitPrice.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
  );

  return pnl;
}

// Check if any stop loss or take profit orders should be triggered.
// Also handles trailing stops and partial exits.
// This should be called for each new candle to simulate order monitoring.

export function checkStopAndTarget(
  symbol: string,
  candle: Candle,
): "STOPPED" | "TARGET_HIT" | "PARTIAL_EXIT" | null {
  const position = state.positions.get(symbol);

  if (!position) {
    return null; // No position to check
  }

  // For LONG positions
  if (position.side === "LONG") {
    // Check if stop loss was hit (candle low <= stop price)
    if (candle.low <= position.stopLoss) {
      logger.normal(
        `Stop loss triggered: ${symbol} hit $${position.stopLoss.toFixed(2)} (candle low: $${candle.low.toFixed(2)})`,
      );
      closePosition(symbol, position.stopLoss, "STOP_LOSS");
      return "STOPPED";
    }

    // Check if take profit was hit (candle high >= target price)
    if (candle.high >= position.takeProfit) {
      logger.normal(
        `Take profit triggered: ${symbol} hit $${position.takeProfit.toFixed(2)} (candle high: $${candle.high.toFixed(2)})`,
      );
      closePosition(symbol, position.takeProfit, "TAKE_PROFIT");
      return "TARGET_HIT";
    }
  }

  // For SHORT positions
  if (position.side === "SHORT") {
    // Check if stop loss was hit (candle high >= stop price)
    if (candle.high >= position.stopLoss) {
      logger.normal(
        `Stop loss triggered: ${symbol} hit $${position.stopLoss.toFixed(2)} (candle high: $${candle.high.toFixed(2)})`,
      );
      closePosition(symbol, position.stopLoss, "STOP_LOSS");
      return "STOPPED";
    }

    // Check if take profit was hit (candle low <= target price)
    if (candle.low <= position.takeProfit) {
      logger.normal(
        `Take profit triggered: ${symbol} hit $${position.takeProfit.toFixed(2)} (candle low: $${candle.low.toFixed(2)})`,
      );
      closePosition(symbol, position.takeProfit, "TAKE_PROFIT");
      return "TARGET_HIT";
    }
  }

  return null; // No stop or target hit
}

// Check for partial exit trigger based on R-multiple profit.
// Returns true if partial exit should be executed.

export function checkPartialExitTrigger(
  position: Position,
  currentPrice: number,
  rMultiple: number,
): boolean {
  if (position.partialExitExecuted) {
    return false; // Already executed
  }

  // Calculate initial risk (R)
  const initialRisk = Math.abs(position.entryPrice - position.initialStopLoss);
  const targetProfit = initialRisk * rMultiple;

  if (position.side === "LONG") {
    // For longs, check if price is at entry + (R × multiple)
    const targetPrice = position.entryPrice + targetProfit;
    return currentPrice >= targetPrice;
  } else {
    // For shorts, check if price is at entry - (R × multiple)
    const targetPrice = position.entryPrice - targetProfit;
    return currentPrice <= targetPrice;
  }
}

// Activate trailing stop for a position.
// Called when profit threshold is reached.

export function activateTrailingStop(position: Position): void {
  if (!position.trailingStopActive) {
    position.trailingStopActive = true;
    logger.normal(
      `Trailing stop activated for ${position.symbol} at ${position.stopLoss.toFixed(2)}`,
    );
  }
}

//==============================================================================
// POSITION CLOSING
//==============================================================================

// Close an open position.

export function closePosition(
  symbol: string,
  exitPrice: number,
  reason: string,
): number | null {
  const position = state.positions.get(symbol);

  if (!position) {
    logger.error(`Cannot close position: No position in ${symbol}`);
    return null;
  }

  // Determine order side for closing (opposite of entry)
  const closeSide = position.side === "LONG" ? "SELL" : "BUY";

  // Create close order
  const closeOrder: Order = {
    symbol,
    side: closeSide,
    quantity: position.quantity,
    type: "MARKET",
    timeInForce: "DAY",
  };

  // Execute close order
  const closeResult = placeMarketOrder(closeOrder, exitPrice);

  if (!closeResult.success) {
    logger.error(`Failed to close position: ${closeResult.error}`);
    return null;
  }

  // Calculate P&L
  let pnl: number;
  if (position.side === "LONG") {
    pnl = (exitPrice - position.entryPrice) * position.quantity;
  } else {
    pnl = (position.entryPrice - exitPrice) * position.quantity;
  }

  // Log trade exit
  const emoji = pnl >= 0 ? "🎯" : "🛑";
  const pnlFormatted = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  logger.normal(`${emoji} TRADE EXIT: ${symbol} @ $${exitPrice.toFixed(2)} | ${reason} | P&L: ${pnlFormatted}`);

  // Remove position
  state.positions.delete(symbol);

  return pnl;
}

// Manually close a position at current market price.
// Used for end-of-day exits or manual intervention.

export function closePositionManual(
  symbol: string,
  currentPrice: number,
): number | null {
  return closePosition(symbol, currentPrice, "MANUAL");
}

//==============================================================================
// POSITION QUERIES
//==============================================================================

// Check if we have an open position in a symbol.

export function hasPosition(symbol: string): boolean {
  return state.positions.has(symbol);
}

// Get the current position for a symbol.

export function getPosition(symbol: string): Position | null {
  return state.positions.get(symbol) || null;
}

// Get all open positions.

export function getAllPositions(): Position[] {
  return Array.from(state.positions.values());
}
