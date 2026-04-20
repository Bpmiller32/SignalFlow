// paperBroker.ts - Simulated trading for testing
// Paper trading simulator that mimics real broker behavior without using real money.
// Orders are filled immediately at current price (no slippage simulation).
// Stop and target orders are checked against each incoming candle.

import {
  Order,
  OrderResult,
  Position,
  PositionSize,
  Candle,
  AccountInfo,
} from "./types";
import * as logger from "./logger";

// ---- PAPER BROKER STATE ----

// in-memory state for paper trading
interface PaperBrokerState {
  accountEquity: number;
  accountCash: number;
  positions: Map<string, Position>; // symbol -> position
  orderIdCounter: number; // counter for generating order IDs
  tradeHistory: Array<{
    symbol: string;
    action: string;
    quantity: number;
    price: number;
    timestamp: Date;
  }>;
}

// initialize paper broker with starting balance
let state: PaperBrokerState = {
  accountEquity: 100000,
  accountCash: 100000,
  positions: new Map(),
  orderIdCounter: 1,
  tradeHistory: [],
};

// ---- INITIALIZATION ----

// initialize paper broker with a starting balance (call once at startup)
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

// get current account information
export function getAccountInfo(): AccountInfo {
  // calculate total equity (cash + position values)
  let positionValue = 0;
  const positionsArray: Position[] = [];

  state.positions.forEach((position) => {
    // use entry price as approximation for current position value
    positionValue += position.quantity * position.entryPrice;
    positionsArray.push(position);
  });

  const totalEquity = state.accountCash + positionValue;

  return {
    equity: totalEquity,
    cash: state.accountCash,
    buyingPower: state.accountCash, // no margin, buying power = cash
    dayTradeCount: 0, // not tracked in paper trading
    positions: positionsArray,
  };
}

// ---- ORDER PLACEMENT ----

// place a market order (filled immediately at current price in paper trading)
export function placeMarketOrder(
  order: Order,
  currentPrice: number,
): OrderResult {
  // generate order ID
  const orderId = `PAPER-${state.orderIdCounter++}`;

  // calculate total cost/proceeds
  const dollarAmount = order.quantity * currentPrice;

  // check if we have enough cash for BUY orders
  if (order.side === "BUY") {
    if (dollarAmount > state.accountCash) {
      logger.error(
        `Insufficient cash for order: Need $${dollarAmount.toFixed(2)}, have $${state.accountCash.toFixed(2)}`,
      );
      return { success: false, orderId: "", error: "Insufficient buying power" };
    }
    // deduct cash
    state.accountCash -= dollarAmount;
  } else {
    // SELL order - add cash
    state.accountCash += dollarAmount;
  }

  // record trade in history
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

// open a new position with entry, stop loss, and take profit
export function openPosition(positionSize: PositionSize): Position | null {
  const symbol = positionSize.symbol;

  // check for existing position in this symbol
  if (state.positions.has(symbol)) {
    logger.error(`Cannot open position: Already have position in ${symbol}`);
    return null;
  }

  // determine order side based on direction
  const side = positionSize.entryPrice < positionSize.targetPrice ? "LONG" : "SHORT";
  const orderSide = side === "LONG" ? "BUY" : "SELL";

  // create and execute entry order
  const entryOrder: Order = {
    symbol,
    side: orderSide,
    quantity: positionSize.quantity,
    type: "MARKET",
    timeInForce: "DAY",
  };

  const entryResult = placeMarketOrder(entryOrder, positionSize.entryPrice);
  if (!entryResult.success) {
    return null;
  }

  // create position object with trailing stop and partial exit tracking
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
      stopLoss: `PAPER-SL-${state.orderIdCounter++}`,
      takeProfit: `PAPER-TP-${state.orderIdCounter++}`,
    },
    initialStopLoss: positionSize.stopPrice,
    highestPrice: side === "LONG" ? positionSize.entryPrice : undefined,
    lowestPrice: side === "SHORT" ? positionSize.entryPrice : undefined,
    trailingStopActive: false,
    originalQuantity: positionSize.quantity,
    partialExitExecuted: false,
  };

  // store position
  state.positions.set(symbol, position);

  logger.normal(
    `Position opened: ${side} ${positionSize.quantity} ${symbol} @ $${positionSize.entryPrice.toFixed(2)} | Stop: $${positionSize.stopPrice.toFixed(2)} | Target: $${positionSize.targetPrice.toFixed(2)}`,
  );

  return position;
}

// ---- POSITION MONITORING ----

// update trailing stop for a position based on current price
export function updateTrailingStop(
  position: Position,
  currentHigh: number,
  currentLow: number,
  trailingDistance: number,
): void {
  // trailing must be active
  if (!position.trailingStopActive) {
    return;
  }

  if (position.side === "LONG") {
    // update highest price seen
    if (currentHigh > (position.highestPrice || position.entryPrice)) {
      position.highestPrice = currentHigh;

      // calculate new trailing stop (only move up, never down)
      const newStop = currentHigh - trailingDistance;
      if (newStop > position.stopLoss) {
        logger.debug(`Trailing stop updated (LONG): ${position.symbol} stop moved from ${position.stopLoss.toFixed(2)} to ${newStop.toFixed(2)}`);
        position.stopLoss = newStop;
      }
    }
  } else {
    // update lowest price seen
    if (currentLow < (position.lowestPrice || position.entryPrice)) {
      position.lowestPrice = currentLow;

      // calculate new trailing stop (only move down, never up)
      const newStop = currentLow + trailingDistance;
      if (newStop < position.stopLoss) {
        logger.debug(`Trailing stop updated (SHORT): ${position.symbol} stop moved from ${position.stopLoss.toFixed(2)} to ${newStop.toFixed(2)}`);
        position.stopLoss = newStop;
      }
    }
  }
}

// execute partial exit on a position, returns P&L from the partial exit
export function executePartialExit(
  position: Position,
  exitPrice: number,
  exitPercent: number,
): number {
  // skip if already executed
  if (position.partialExitExecuted) {
    logger.debug(`Partial exit already executed for ${position.symbol}, skipping`);
    return 0;
  }

  // calculate quantity to exit
  const exitQuantity = Math.floor(position.originalQuantity * (exitPercent / 100));
  if (exitQuantity < 1) {
    logger.debug(`Partial exit quantity too small: ${exitQuantity} shares, skipping`);
    return 0;
  }

  // calculate P&L on partial exit
  let pnl: number;
  if (position.side === "LONG") {
    pnl = (exitPrice - position.entryPrice) * exitQuantity;
  } else {
    pnl = (position.entryPrice - exitPrice) * exitQuantity;
  }

  // execute the partial exit order
  const closeSide = position.side === "LONG" ? "SELL" : "BUY";
  const closeOrder: Order = {
    symbol: position.symbol,
    side: closeSide,
    quantity: exitQuantity,
    type: "MARKET",
    timeInForce: "DAY",
  };
  placeMarketOrder(closeOrder, exitPrice);

  // update position
  position.quantity -= exitQuantity;
  position.partialExitExecuted = true;

  logger.normal(
    `Partial exit executed: ${position.symbol} closed ${exitQuantity}/${position.originalQuantity} shares @ ${exitPrice.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
  );

  return pnl;
}

// check if any stop loss or take profit orders should trigger on this candle
export function checkStopAndTarget(
  symbol: string,
  candle: Candle,
): "STOPPED" | "TARGET_HIT" | "PARTIAL_EXIT" | null {
  const position = state.positions.get(symbol);
  if (!position) {
    return null;
  }

  // for LONG positions
  if (position.side === "LONG") {
    // check stop loss (candle low <= stop price)
    if (candle.low <= position.stopLoss) {
      logger.normal(`Stop loss triggered: ${symbol} hit $${position.stopLoss.toFixed(2)} (candle low: $${candle.low.toFixed(2)})`);
      closePosition(symbol, position.stopLoss, "STOP_LOSS");
      return "STOPPED";
    }

    // check take profit (candle high >= target price)
    if (candle.high >= position.takeProfit) {
      logger.normal(`Take profit triggered: ${symbol} hit $${position.takeProfit.toFixed(2)} (candle high: $${candle.high.toFixed(2)})`);
      closePosition(symbol, position.takeProfit, "TAKE_PROFIT");
      return "TARGET_HIT";
    }
  }

  // for SHORT positions
  if (position.side === "SHORT") {
    // check stop loss (candle high >= stop price)
    if (candle.high >= position.stopLoss) {
      logger.normal(`Stop loss triggered: ${symbol} hit $${position.stopLoss.toFixed(2)} (candle high: $${candle.high.toFixed(2)})`);
      closePosition(symbol, position.stopLoss, "STOP_LOSS");
      return "STOPPED";
    }

    // check take profit (candle low <= target price)
    if (candle.low <= position.takeProfit) {
      logger.normal(`Take profit triggered: ${symbol} hit $${position.takeProfit.toFixed(2)} (candle low: $${candle.low.toFixed(2)})`);
      closePosition(symbol, position.takeProfit, "TAKE_PROFIT");
      return "TARGET_HIT";
    }
  }

  // no stop or target hit
  return null;
}

// check if partial exit should trigger based on R-multiple profit
export function checkPartialExitTrigger(
  position: Position,
  currentPrice: number,
  rMultiple: number,
): boolean {
  // skip if already executed
  if (position.partialExitExecuted) {
    return false;
  }

  // calculate initial risk (1R) and target profit
  const initialRisk = Math.abs(position.entryPrice - position.initialStopLoss);
  const targetProfit = initialRisk * rMultiple;

  if (position.side === "LONG") {
    return currentPrice >= position.entryPrice + targetProfit;
  } else {
    return currentPrice <= position.entryPrice - targetProfit;
  }
}

// activate trailing stop for a position
export function activateTrailingStop(position: Position): void {
  if (!position.trailingStopActive) {
    position.trailingStopActive = true;
    logger.normal(`Trailing stop activated for ${position.symbol} at ${position.stopLoss.toFixed(2)}`);
  }
}

// ---- POSITION CLOSING ----

// close an open position
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

  // create and execute close order (opposite side of entry)
  const closeSide = position.side === "LONG" ? "SELL" : "BUY";
  const closeOrder: Order = {
    symbol,
    side: closeSide,
    quantity: position.quantity,
    type: "MARKET",
    timeInForce: "DAY",
  };

  const closeResult = placeMarketOrder(closeOrder, exitPrice);
  if (!closeResult.success) {
    logger.error(`Failed to close position: ${closeResult.error}`);
    return null;
  }

  // calculate P&L
  let pnl: number;
  if (position.side === "LONG") {
    pnl = (exitPrice - position.entryPrice) * position.quantity;
  } else {
    pnl = (position.entryPrice - exitPrice) * position.quantity;
  }

  // log trade exit
  const emoji = pnl >= 0 ? "🎯" : "🛑";
  const pnlFormatted = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  logger.normal(`${emoji} TRADE EXIT: ${symbol} @ $${exitPrice.toFixed(2)} | ${reason} | P&L: ${pnlFormatted}`);

  // remove position
  state.positions.delete(symbol);

  return pnl;
}

// manually close a position at current market price (used for end-of-day exits)
export function closePositionManual(
  symbol: string,
  currentPrice: number,
): number | null {
  return closePosition(symbol, currentPrice, "MANUAL");
}

// ---- POSITION QUERIES ----

// check if we have an open position in a symbol
export function hasPosition(symbol: string): boolean {
  return state.positions.has(symbol);
}

// get the current position for a symbol
export function getPosition(symbol: string): Position | null {
  return state.positions.get(symbol) || null;
}

// get all open positions
export function getAllPositions(): Position[] {
  return Array.from(state.positions.values());
}
