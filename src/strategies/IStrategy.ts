// IStrategy.ts - Strategy interface that all trading strategies must implement
// The runner calls these methods. The strategy returns decisions. The runner executes them.
// To add a new strategy: implement this interface, register in strategyRunner.ts createStrategy()

import {
  Candle,
  Signal,
  FVGPattern,
  Position,
  PositionSize,
  OpeningRange,
  StrategyConfig,
  OpeningRangeResult,
  CandleResult,
  PositionUpdate,
} from "../types";

export interface IStrategy {
  // human-readable name (from config id)
  readonly name: string;

  // strategy type key (e.g. "opening-range-breakout")
  readonly type: string;

  // called once at startup, sets up internal state for each symbol
  initialize(symbols: string[]): void;

  // called with the opening range candle, returns accept/reject with details
  evaluateOpeningRange(
    symbol: string,
    candle: Candle,
    previousDayClose: number | null,
  ): OpeningRangeResult;

  // called on each new candle during monitoring, returns signal or null
  processCandle(symbol: string, candle: Candle): CandleResult;

  // called when a signal is generated, returns position sizing or null to skip
  calculatePositionSize(
    symbol: string,
    signal: Signal,
    openingRange: OpeningRange,
    fvgPattern: FVGPattern,
    accountEquity: number,
  ): PositionSize | null;

  // called on each candle when position is open, returns what to do
  evaluatePosition(
    symbol: string,
    candle: Candle,
    position: Position,
  ): PositionUpdate;

  // called end of day, resets internal state for next session
  reset(symbol: string): void;

  // returns the strategy config from JSON
  getConfig(): StrategyConfig;
}
