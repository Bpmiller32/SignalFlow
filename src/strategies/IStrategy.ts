// IStrategy.ts - Generic strategy interface
// Any trading strategy must implement this interface.
// The runner feeds candles. The strategy makes ALL decisions.
// No assumptions about strategy type (day trade, swing, multi-day, etc.)

import {
  Candle,
  Position,
  StrategyConfig,
  StrategyAction,
  PositionUpdate,
} from "../types";

export interface IStrategy {
  // human-readable name (from config id)
  readonly name: string;

  // strategy type key (e.g. "opening-range-breakout", "mean-reversion")
  readonly type: string;

  // if true, positions survive overnight (not force-closed at EOD)
  readonly holdOvernight: boolean;

  // called once at startup or start of each trading day, resets internal state
  initialize(symbols: string[]): void;

  // called at start of each trading session after the setup window ends
  // date is the trading date (YYYY-MM-DD) - live passes today, backtester passes historical
  // strategy fetches whatever data it needs internally (opening range candles, daily data, etc.)
  onSessionStart(date: string): Promise<void>;

  // called on each new 1-min candle during the monitoring phase
  // strategy handles everything: setup checks, signal detection, position sizing
  // returns what it wants to do: nothing, enter a trade, or stop for the day
  onCandle(symbol: string, candle: Candle, accountEquity: number): StrategyAction;

  // called on each candle when a position is open for this symbol
  // returns what to do: hold, partial exit, update stop, close position
  evaluatePosition(symbol: string, candle: Candle, position: Position): PositionUpdate;

  // called at end of each trading session (market close)
  onSessionEnd(): void;

  // returns the strategy config loaded from strategies.json
  getConfig(): StrategyConfig;
}
