//==============================================================================
// TYPES.TS - ALL TYPESCRIPT INTERFACES AND TYPES
//==============================================================================
// This file contains every interface and type used throughout the application.
// Keeping all types in one place makes it easy to understand the data structures
// and ensures consistency across the entire codebase.
//==============================================================================

//==============================================================================
// CONFIGURATION TYPES
//==============================================================================

// Main application configuration loaded from .env file
export interface Config {
  // Mode selection
  mode: "PAPER" | "LIVE"; // Trading mode

  // API credentials (Alpaca only - using for both data and trading)
  alpacaApiKey: string;
  alpacaSecretKey: string;
  alpacaBaseUrl: string;

  // Discord webhooks
  discordWebhookTrades: string;
  discordWebhookSystem: string;
  discordWebhookErrors: string;

  // Trading settings
  symbols: string[]; // Array of stock symbols to trade
  maxTradesPerDay: number; // Maximum trades per day per symbol
  strategyCutoffTime: string; // Time to stop entering new trades (EST)

  // Position sizing
  positionSizeMode: "FIXED" | "RISK_BASED";
  fixedPositionSize: number; // Dollar amount for FIXED mode
  accountRiskPercent: number; // Percentage for RISK_BASED mode
  maxPositionValue: number; // Maximum position size in dollars
  minPositionValue: number; // Minimum position size in dollars

  // Risk management
  riskRewardRatio: number; // Target profit vs risk ratio (e.g., 2.0 = 2:1)
  stopLossBufferPercent: number; // Buffer added to stop loss

  // ATR-based stops
  useAtrStops: boolean; // Use ATR for stops instead of opening range
  atrPeriod: number; // ATR calculation period (e.g., 14)
  atrStopMultiplier: number; // ATR multiplier for stops (e.g., 1.5)

  // Trailing stops
  useTrailingStops: boolean; // Enable trailing stops
  trailingStopActivation: number; // R-multiple to activate trailing (e.g., 1.0 = 1R)
  trailingStopAtrMultiple: number; // ATR distance for trailing stop

  // Partial exits
  usePartialExits: boolean; // Enable partial profit taking
  partialExitAtRMultiple: number; // R-multiple to take partial profit (e.g., 1.0)
  partialExitPercent: number; // Percentage to exit (e.g., 50 = 50%)

  // Adaptive position sizing (size based on signal quality)
  useAdaptivePositionSizing: boolean; // Enable signal-based sizing
  weakSignalSizePercent: number; // Position size for weak signals (e.g., 50 = 50%)

  // Opening range filters
  openingRangeMinSize: number; // Minimum range as % of price
  openingRangeMaxSize: number; // Maximum range as % of price

  // Fair Value Gap (FVG) rules
  fvgBodyPercent: number; // Required body size as % of candle range
  fvgMinRangePercent: number; // Minimum candle range as % of price
  fvgOverlapTolerance: number; // Allowed gap overlap as %
  fvgClosePositionPercent: number; // Where close must be in candle range
  requireVolumeConfirmation: boolean; // Require volume spike
  volumeMultiplier: number; // Volume multiplier for confirmation

  // Logging
  logLevel: "normal" | "debug";
  saveCandleData: boolean; // Save candles to JSON files

  // Earnings filter
  skipEarningsDays: boolean; // Skip trading on earnings days

  // Opening range strength filter
  openingRangeMinStrength: number; // Minimum OR strength score (0-10)

  // Volume safety threshold
  minAbsoluteVolumePerMinute: number; // Minimum volume per minute (prevents low liquidity)

  // Stale breakout timeout
  maxFvgWindowMinutes: number; // Max time to complete FVG after breakout (invalidate stale)

  // Pre-market gap filter
  maxPremarketGapPercent: number; // Maximum pre-market gap allowed (% from previous close)
}

//==============================================================================
// MARKET DATA TYPES
//==============================================================================

// Single candlestick with OHLC data
export interface Candle {
  symbol: string; // Stock symbol (e.g., "SPY")
  timestamp: Date; // Candle timestamp in EST
  open: number; // Opening price
  high: number; // Highest price
  low: number; // Lowest price
  close: number; // Closing price
  volume: number; // Trading volume
  vwap?: number; // Volume-weighted average price (for quality analysis)
  tradeCount?: number; // Number of trades (detects institutional vs retail)
}

// Opening range calculated from first 5-minute candle
export interface OpeningRange {
  high: number; // High of opening range
  low: number; // Low of opening range
  size: number; // Range size as % of price
  sizeInDollars: number; // Range size in dollars
  timestamp: Date; // When range was established
}

//==============================================================================
// STRATEGY TYPES
//==============================================================================

// Trading signal generated by strategy
export interface Signal {
  symbol: string; // What to trade
  direction: "LONG" | "SHORT"; // Buy or sell
  timestamp: Date; // When signal was generated
  currentPrice: number; // Price at signal generation
  reason: string; // Why this signal was generated
}

// Fair Value Gap pattern detection result
export interface FVGPattern {
  detected: boolean; // Was pattern found
  direction: "BULLISH" | "BEARISH" | null; // Pattern direction
  candle1: Candle; // First candle (breakout)
  candle2: Candle; // Second candle (momentum)
  candle3: Candle; // Third candle (gap)
  details: string; // Human-readable explanation
}

// Breakout detection result
export interface Breakout {
  detected: boolean; // Did price break range
  direction: "ABOVE" | "BELOW" | null; // Which way
  candle: Candle; // Candle that broke range
  openingRange: OpeningRange; // The range that was broken
}

//==============================================================================
// POSITION & ORDER TYPES
//==============================================================================

// Active trading position
export interface Position {
  symbol: string; // What we're holding
  side: "LONG" | "SHORT"; // Direction
  entryPrice: number; // Price we entered at
  quantity: number; // Number of shares
  entryTime: Date; // When we entered
  stopLoss: number; // Stop loss price
  takeProfit: number; // Take profit price
  orderIds: {
    entry: string; // Entry order ID
    stopLoss: string; // Stop loss order ID
    takeProfit: string; // Take profit order ID
  };
  // Trailing stop tracking
  initialStopLoss: number; // Original stop loss
  highestPrice?: number; // Highest price since entry (for LONG)
  lowestPrice?: number; // Lowest price since entry (for SHORT)
  trailingStopActive: boolean; // Is trailing stop enabled
  // Partial exit tracking
  originalQuantity: number; // Quantity at entry
  partialExitExecuted: boolean; // Has partial exit occurred
}

// Order to be placed with broker
export interface Order {
  symbol: string; // What to trade
  side: "BUY" | "SELL"; // Buy or sell
  quantity: number; // Number of shares
  type: "MARKET" | "LIMIT" | "STOP"; // Order type
  price?: number; // Limit/stop price (if applicable)
  timeInForce: "DAY" | "GTC"; // Order duration
}

// Result of position sizing calculation
export interface PositionSize {
  symbol: string; // What we're sizing for
  quantity: number; // Number of shares to trade
  dollarValue: number; // Total dollar value of position
  entryPrice: number; // Price we'll enter at
  stopPrice: number; // Stop loss price
  targetPrice: number; // Take profit price
  riskPerShare: number; // Risk per share in dollars
  totalRisk: number; // Total dollar risk
  potentialProfit: number; // Potential dollar profit
  riskRewardRatio: number; // Ratio of profit to risk
}

//==============================================================================
// TRADE TRACKING TYPES
//==============================================================================

// Completed trade with full details
export interface Trade {
  id: string; // Unique trade ID
  symbol: string; // What was traded
  side: "LONG" | "SHORT"; // Direction
  entryTime: Date; // When we entered
  entryPrice: number; // Entry price
  quantity: number; // Number of shares
  exitTime: Date; // When we exited
  exitPrice: number; // Exit price
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "END_OF_DAY"; // Why we exited
  pnl: number; // Profit/loss in dollars
  pnlPercent: number; // Profit/loss as percentage
  fees: number; // Trading fees
  holdingTime: number; // How long we held (in seconds)
}

// Statistics for tracking performance
export interface TradingStats {
  totalTrades: number; // Total number of trades
  wins: number; // Number of winning trades
  losses: number; // Number of losing trades
  winRate: number; // Win rate as percentage
  totalPnL: number; // Total profit/loss
  bestTrade: number; // Best single trade P&L
  worstTrade: number; // Worst single trade P&L
  averageWin: number; // Average winning trade
  averageLoss: number; // Average losing trade
  currentStreak: {
    type: "WIN" | "LOSS"; // Current streak type
    count: number; // How many in a row
  };
  longestWinStreak: number; // Longest winning streak
  longestLossStreak: number; // Longest losing streak
}

//==============================================================================
// STATE MANAGEMENT TYPES
//==============================================================================

// Daily state for a symbol (persisted to JSON)
export interface DailyState {
  date: string; // Trading date (YYYY-MM-DD)
  symbol: string; // Stock symbol
  openingRange: OpeningRange | null; // Opening range if captured
  openingRangeCandle?: Candle; // Full opening range candle for volume/ATR
  tradeExecutedToday: boolean; // Have we traded yet today
  tradeCount: number; // Number of trades executed today
  sessionStatus:
    | "WAITING"
    | "CAPTURING_RANGE"
    | "MONITORING"
    | "POSITION_OPEN"
    | "DONE"; // Current state
  lastUpdated: Date; // Last state update time
}

// Current position state (persisted to JSON)
export interface CurrentPositionState {
  symbol: string; // What we're holding
  side: "LONG" | "SHORT"; // Direction
  entryPrice: number; // Entry price
  quantity: number; // Number of shares
  entryTime: Date; // Entry timestamp
  stopLoss: number; // Stop loss price
  takeProfit: number; // Take profit price
  orderIds: {
    entry: string; // Entry order ID
    stopLoss: string; // Stop loss order ID
    takeProfit: string; // Take profit order ID
  };
  // Trailing stop fields
  initialStopLoss: number; // Original stop loss
  highestPrice?: number; // Highest price since entry (for LONG)
  lowestPrice?: number; // Lowest price since entry (for SHORT)
  trailingStopActive: boolean; // Is trailing stop enabled
  // Partial exit fields
  originalQuantity: number; // Quantity at entry
  partialExitExecuted: boolean; // Has partial exit occurred
}

// Trade history file structure (persisted to JSON)
export interface TradeHistory {
  date: string; // Trading date
  trades: Trade[]; // All trades for this date
}

// All-time statistics (persisted to JSON)
export interface AllTimeStats {
  allTimeStats: TradingStats; // Overall statistics
  symbolStats: { [symbol: string]: TradingStats }; // Per-symbol stats
  lastUpdated: Date; // Last update time
}

//==============================================================================
// BROKER INTERFACE TYPES
//==============================================================================

// Broker account information
export interface AccountInfo {
  equity: number; // Total account value
  cash: number; // Available cash
  buyingPower: number; // Buying power
  dayTradeCount: number; // Pattern day trades in last 5 days
  positions: Position[]; // Open positions
}

// Result of an order execution
export interface OrderResult {
  success: boolean; // Was order successful
  orderId: string; // Order ID from broker
  filledPrice?: number; // Price order was filled at
  filledQuantity?: number; // Quantity that was filled
  error?: string; // Error message if failed
}

//==============================================================================
// MARKET HOURS TYPES
//==============================================================================

// Market hours and status
export interface MarketHours {
  isOpen: boolean; // Is market currently open
  nextOpen: Date; // Next market open time
  nextClose: Date; // Next market close time
  hoursUntilOpen: number; // Hours until next open
  hoursUntilClose: number; // Hours until next close
}

//==============================================================================
// REJECTION TRACKING TYPES
//==============================================================================

// Single rejection event
export interface Rejection {
  timestamp: Date; // When rejection occurred
  symbol: string; // Symbol that was rejected
  stage: RejectionStage; // At what stage rejection happened
  reason: string; // Human-readable reason
  details?: any; // Additional context (optional)
}

// Rejection stages
export type RejectionStage =
  | "PRE_MARKET_GAP" // Gap too large
  | "OPENING_RANGE_SIZE" // Size outside limits
  | "OPENING_RANGE_STRENGTH" // Strength score too low
  | "BREAKOUT_VOLUME" // Breakout volume too low
  | "FVG_PATTERN" // FVG requirements not met
  | "TIME_WINDOW" // Outside allowed hours
  | "MARKET_REGIME" // Against market trend
  | "SIGNAL_QUALITY" // Signal quality too weak
  | "EARNINGS_EVENT"; // Earnings day

// Daily rejection log
export interface RejectionLog {
  date: string; // Trading date
  rejections: Rejection[]; // All rejections for this date
}
