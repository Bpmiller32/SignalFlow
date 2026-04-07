// config.ts - Global configuration loader
// Loads configuration from the .env file and validates required values.
// Only global settings live here (API keys, Discord, mode, logging).
// Strategy-specific settings are in strategies.json and loaded by each strategy.

import * as dotenv from "dotenv";
import { Config } from "./types";

// load environment variables from .env file
dotenv.config();

// ---- HELPER FUNCTIONS ----

// get a required environment variable or throw an error
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// get an optional environment variable with a default value
function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

// ---- CONFIGURATION LOADING ----

// load and validate all configuration from environment variables
export function loadConfig(): Config {
  // validate mode
  const mode = getOptionalEnv("MODE", "PAPER").toUpperCase();
  if (mode !== "PAPER" && mode !== "LIVE") {
    throw new Error(`Invalid MODE: ${mode}. Must be PAPER or LIVE`);
  }

  // load API credentials
  const alpacaApiKey = getRequiredEnv("ALPACA_API_KEY");
  const alpacaSecretKey = getRequiredEnv("ALPACA_SECRET_KEY");
  const alpacaBaseUrl = getOptionalEnv(
    "ALPACA_BASE_URL",
    "https://paper-api.alpaca.markets",
  );

  // load discord bot config
  const discordBotToken = getRequiredEnv("DISCORD_BOT_TOKEN");
  const discordGuildId = getRequiredEnv("DISCORD_GUILD_ID");
  const discordChannelId = getOptionalEnv("DISCORD_CHANNEL_ID", "");

  // load logging settings
  const logLevel = getOptionalEnv("LOG_LEVEL", "normal").toLowerCase();
  if (logLevel !== "normal" && logLevel !== "debug") {
    throw new Error(`Invalid LOG_LEVEL: ${logLevel}. Must be normal or debug`);
  }

  // return validated configuration
  return {
    mode: mode as "PAPER" | "LIVE",
    alpacaApiKey,
    alpacaSecretKey,
    alpacaBaseUrl,
    discordBotToken,
    discordGuildId,
    discordChannelId,
    logLevel: logLevel as "normal" | "debug",
  };
}

// ---- EXPORT SINGLETON CONFIG ----

// load and validate configuration once when module is imported
let config: Config;

try {
  config = loadConfig();
} catch (error) {
  console.error("❌ Configuration Error:");
  console.error((error as Error).message);
  console.error(
    "\nPlease check your .env file and ensure all required variables are set.",
  );
  console.error("See .env.example for reference.");
  process.exit(1);
}

// export the validated configuration
export default config;
