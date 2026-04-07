//==============================================================================
// CONFIG.TS - CONFIGURATION LOADER AND VALIDATOR
//==============================================================================
// This file loads configuration from the .env file and validates all values.
// If any required values are missing or invalid, the app will not start.
// This ensures we catch configuration errors early before trading begins.
//==============================================================================

import * as dotenv from "dotenv";
import { Config } from "./types";

// Load environment variables from .env file
dotenv.config();

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

// Get a required environment variable or throw an error
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// Get an optional environment variable with a default value
function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

// Parse a number from environment variable
function getNumberEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for ${key}: ${value}`);
  }
  return parsed;
}

// Parse a boolean from environment variable
function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

//==============================================================================
// CONFIGURATION LOADING
//==============================================================================

// Load and validate all configuration from environment variables
export function loadConfig(): Config {
  // Validate mode
  const mode = getOptionalEnv("MODE", "PAPER").toUpperCase();
  if (mode !== "PAPER" && mode !== "LIVE") {
    throw new Error(`Invalid MODE: ${mode}. Must be PAPER or LIVE`);
  }

  // Load API credentials (Alpaca only - using Alpaca for both data and trading)
  const alpacaApiKey = getRequiredEnv("ALPACA_API_KEY");
  const alpacaSecretKey = getRequiredEnv("ALPACA_SECRET_KEY");
  const alpacaBaseUrl = getOptionalEnv(
    "ALPACA_BASE_URL",
    "https://paper-api.alpaca.markets",
  );

  // Load Discord bot config
  const discordBotToken = getRequiredEnv("DISCORD_BOT_TOKEN");
  const discordGuildId = getRequiredEnv("DISCORD_GUILD_ID");
  const discordChannelTrades = getOptionalEnv("DISCORD_CHANNEL_TRADES", "");
  const discordChannelSystem = getOptionalEnv("DISCORD_CHANNEL_SYSTEM", "");
  const discordChannelErrors = getOptionalEnv("DISCORD_CHANNEL_ERRORS", "");

  // Load trading settings
  const symbolsString = getOptionalEnv("SYMBOLS", "SPY");
  const symbols = symbolsString.split(",").map((s) => s.trim().toUpperCase());
  const maxTradesPerDay = getNumberEnv("MAX_TRADES_PER_DAY", 2);
  const strategyCutoffTime = getOptionalEnv("STRATEGY_CUTOFF_TIME", "11:30");

  // Load position sizing settings
  const positionSizeMode = getOptionalEnv(
    "POSITION_SIZE_MODE",
    "FIXED",
  ).toUpperCase();
  if (positionSizeMode !== "FIXED" && positionSizeMode !== "RISK_BASED") {
    throw new Error(
      `Invalid POSITION_SIZE_MODE: ${positionSizeMode}. Must be FIXED or RISK_BASED`,
    );
  }
  const fixedPositionSize = getNumberEnv("FIXED_POSITION_SIZE", 1000);
  const accountRiskPercent = getNumberEnv("ACCOUNT_RISK_PERCENT", 1.0);
  const maxPositionValue = getNumberEnv("MAX_POSITION_VALUE", 10000);
  const minPositionValue = getNumberEnv("MIN_POSITION_VALUE", 100);

  // Load risk management settings
  const riskRewardRatio = getNumberEnv("RISK_REWARD_RATIO", 2.0);
  const stopLossBufferPercent = getNumberEnv("STOP_LOSS_BUFFER_PERCENT", 0.05);

  // Load ATR-based stops settings
  const useAtrStops = getBooleanEnv("USE_ATR_STOPS", false);
  const atrPeriod = getNumberEnv("ATR_PERIOD", 14);
  const atrStopMultiplier = getNumberEnv("ATR_STOP_MULTIPLIER", 1.5);

  // Load trailing stops settings
  const useTrailingStops = getBooleanEnv("USE_TRAILING_STOPS", false);
  const trailingStopActivation = getNumberEnv("TRAILING_STOP_ACTIVATION", 1.0);
  const trailingStopAtrMultiple = getNumberEnv(
    "TRAILING_STOP_ATR_MULTIPLE",
    1.5,
  );

  // Load partial exits settings
  const usePartialExits = getBooleanEnv("USE_PARTIAL_EXITS", false);
  const partialExitAtRMultiple = getNumberEnv("PARTIAL_EXIT_AT_R_MULTIPLE", 1.0);
  const partialExitPercent = getNumberEnv("PARTIAL_EXIT_PERCENT", 50);

  // Load adaptive position sizing settings
  const useAdaptivePositionSizing = getBooleanEnv(
    "USE_ADAPTIVE_POSITION_SIZING",
    true,
  );
  const weakSignalSizePercent = getNumberEnv("WEAK_SIGNAL_SIZE_PERCENT", 50);

  // Load opening range filters
  const openingRangeMinSize = getNumberEnv("OPENING_RANGE_MIN_SIZE", 0.15);
  const openingRangeMaxSize = getNumberEnv("OPENING_RANGE_MAX_SIZE", 2.0);

  // Load FVG rules
  const fvgBodyPercent = getNumberEnv("FVG_BODY_PERCENT", 55);
  const fvgMinRangePercent = getNumberEnv("FVG_MIN_RANGE_PERCENT", 0.15);
  const fvgOverlapTolerance = getNumberEnv("FVG_OVERLAP_TOLERANCE", 1.5);
  const fvgClosePositionPercent = getNumberEnv(
    "FVG_CLOSE_POSITION_PERCENT",
    25,
  );
  const requireVolumeConfirmation = getBooleanEnv(
    "REQUIRE_VOLUME_CONFIRMATION",
    true,
  );
  const volumeMultiplier = getNumberEnv("VOLUME_MULTIPLIER", 1.5);

  // Load logging settings
  const logLevel = getOptionalEnv("LOG_LEVEL", "normal").toLowerCase();
  if (logLevel !== "normal" && logLevel !== "debug") {
    throw new Error(`Invalid LOG_LEVEL: ${logLevel}. Must be normal or debug`);
  }
  const saveCandleData = getBooleanEnv("SAVE_CANDLE_DATA", true);

  // Load earnings filter
  const skipEarningsDays = getBooleanEnv("SKIP_EARNINGS_DAYS", true);

  // Load opening range strength filter
  const openingRangeMinStrength = getNumberEnv("OPENING_RANGE_MIN_STRENGTH", 5.0);

  // Load minimum absolute volume threshold
  const minAbsoluteVolumePerMinute = getNumberEnv("MIN_ABSOLUTE_VOLUME_PER_MINUTE", 10000);

  // Load stale breakout timeout
  const maxFvgWindowMinutes = getNumberEnv("MAX_FVG_WINDOW_MINUTES", 5);

  // Load pre-market gap filter
  const maxPremarketGapPercent = getNumberEnv("MAX_PREMARKET_GAP_PERCENT", 1.0);

  // Return validated configuration
  return {
    mode: mode as "PAPER" | "LIVE",
    alpacaApiKey,
    alpacaSecretKey,
    alpacaBaseUrl,
    discordBotToken,
    discordGuildId,
    discordChannelTrades,
    discordChannelSystem,
    discordChannelErrors,
    symbols,
    maxTradesPerDay,
    strategyCutoffTime,
    positionSizeMode: positionSizeMode as "FIXED" | "RISK_BASED",
    fixedPositionSize,
    accountRiskPercent,
    maxPositionValue,
    minPositionValue,
    riskRewardRatio,
    stopLossBufferPercent,
    useAtrStops,
    atrPeriod,
    atrStopMultiplier,
    useTrailingStops,
    trailingStopActivation,
    trailingStopAtrMultiple,
    usePartialExits,
    partialExitAtRMultiple,
    partialExitPercent,
    useAdaptivePositionSizing,
    weakSignalSizePercent,
    openingRangeMinSize,
    openingRangeMaxSize,
    fvgBodyPercent,
    fvgMinRangePercent,
    fvgOverlapTolerance,
    fvgClosePositionPercent,
    requireVolumeConfirmation,
    volumeMultiplier,
    logLevel: logLevel as "normal" | "debug",
    saveCandleData,
    skipEarningsDays,
    openingRangeMinStrength,
    minAbsoluteVolumePerMinute,
    maxFvgWindowMinutes,
    maxPremarketGapPercent,
  };
}

//==============================================================================
// CONFIGURATION VALIDATION
//==============================================================================

// Validate configuration values make sense
export function validateConfig(config: Config): void {
  // Validate symbols
  if (config.symbols.length === 0) {
    throw new Error("SYMBOLS cannot be empty. Provide at least one symbol.");
  }

  // Validate position sizing
  if (config.fixedPositionSize <= 0) {
    throw new Error("FIXED_POSITION_SIZE must be greater than 0");
  }
  if (config.accountRiskPercent <= 0 || config.accountRiskPercent > 100) {
    throw new Error("ACCOUNT_RISK_PERCENT must be between 0 and 100");
  }
  if (config.maxPositionValue < config.minPositionValue) {
    throw new Error(
      "MAX_POSITION_VALUE must be greater than MIN_POSITION_VALUE",
    );
  }

  // Validate risk management
  if (config.riskRewardRatio <= 0) {
    throw new Error("RISK_REWARD_RATIO must be greater than 0");
  }

  // Validate opening range filters
  if (config.openingRangeMinSize < 0 || config.openingRangeMinSize > 100) {
    throw new Error("OPENING_RANGE_MIN_SIZE must be between 0 and 100");
  }
  if (config.openingRangeMaxSize < 0 || config.openingRangeMaxSize > 100) {
    throw new Error("OPENING_RANGE_MAX_SIZE must be between 0 and 100");
  }
  if (config.openingRangeMaxSize < config.openingRangeMinSize) {
    throw new Error(
      "OPENING_RANGE_MAX_SIZE must be greater than OPENING_RANGE_MIN_SIZE",
    );
  }

  // Validate FVG rules
  if (config.fvgBodyPercent < 0 || config.fvgBodyPercent > 100) {
    throw new Error("FVG_BODY_PERCENT must be between 0 and 100");
  }
  if (
    config.fvgClosePositionPercent < 0 ||
    config.fvgClosePositionPercent > 100
  ) {
    throw new Error("FVG_CLOSE_POSITION_PERCENT must be between 0 and 100");
  }
  if (config.volumeMultiplier <= 0) {
    throw new Error("VOLUME_MULTIPLIER must be greater than 0");
  }

  // Validate strategy cutoff time format (HH:MM)
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(config.strategyCutoffTime)) {
    throw new Error(
      "STRATEGY_CUTOFF_TIME must be in HH:MM format (e.g., 11:30)",
    );
  }
}

//==============================================================================
// EXPORT SINGLETON CONFIG
//==============================================================================

// Load and validate configuration once when module is imported
let config: Config;

try {
  config = loadConfig();
  validateConfig(config);
} catch (error) {
  console.error("❌ Configuration Error:");
  console.error((error as Error).message);
  console.error(
    "\nPlease check your .env file and ensure all required variables are set.",
  );
  console.error("See .env.example for reference.");
  process.exit(1);
}

// Export the validated configuration
export default config;
