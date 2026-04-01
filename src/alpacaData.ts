//==============================================================================
// ALPACADATA.TS - ALPACA MARKET DATA CLIENT
//==============================================================================
// This file handles fetching market data from Alpaca's API.
// We fetch both 5-minute candles (for opening range) and 1-minute candles
// (for breakout detection and FVG pattern recognition).
// 
// BENEFITS OF ALPACA DATA:
// - Real-time market data (with Algo Trader Plus plan)
// - Integrated with trading API (same credentials)
// - Cost-effective ($99/month vs $200/month for Polygon)
// - Simple async iterator API
//==============================================================================

import Alpaca from "@alpacahq/alpaca-trade-api";
import config from "./config";
import * as logger from "./logger";
import { Candle } from "./types";

//==============================================================================
// ALPACA CLIENT INITIALIZATION
//==============================================================================

let alpacaClient: Alpaca;

// Initialize Alpaca client (lazy initialization)
function getAlpacaClient(): Alpaca {
  if (!alpacaClient) {
    alpacaClient = new Alpaca({
      keyId: config.alpacaApiKey,
      secretKey: config.alpacaSecretKey,
      paper: config.alpacaBaseUrl.includes("paper"),
    });
  }
  return alpacaClient;
}

//==============================================================================
// RATE LIMITING
//==============================================================================
// Alpaca has generous rate limits (200 requests/minute for Algo Trader Plus)
// We still add minimal rate limiting to be a good API citizen

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 50; // 50ms between requests = 20 req/sec

// Sleep function for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Apply rate limiting before making API request
async function applyRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const delayNeeded = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    logger.debug(`Rate limiting: waiting ${delayNeeded}ms before next request`);
    await sleep(delayNeeded);
  }

  lastRequestTime = Date.now();
}

//==============================================================================
// CANDLE FETCHING
//==============================================================================

// Fetch 5-minute candles for a symbol (used for opening range)
// Returns candles for a specific date
export async function fetch5MinCandles(
  symbol: string,
  date: string,
): Promise<Candle[]> {
  try {
    await applyRateLimit();

    logger.debug(`Fetching 5-min candles for ${symbol} on ${date}`);

    const client = getAlpacaClient();

    // Calculate start and end times for the trading day
    const startTime = `${date}T09:30:00-05:00`; // Market open EST
    const endTime = `${date}T16:00:00-05:00`; // Market close EST

    // Fetch bars using Alpaca's getBarsV2 API
    const bars = client.getBarsV2(symbol, {
      start: startTime,
      end: endTime,
      timeframe: "5Min",
      feed: "sip", // SIP feed = consolidated real-time data
      limit: 10000,
    });

    // Collect bars into array
    const candles: Candle[] = [];
    for await (const bar of bars) {
      candles.push({
        symbol,
        timestamp: new Date(bar.Timestamp),
        open: bar.OpenPrice,
        high: bar.HighPrice,
        low: bar.LowPrice,
        close: bar.ClosePrice,
        volume: bar.Volume,
        vwap: (bar as any).VWAP || (bar as any).VWAPPrice, // Volume-weighted average price (if available)
        tradeCount: (bar as any).TradeCount || (bar as any).n, // Number of trades (if available)
      });
    }

    logger.debug(`Fetched ${candles.length} 5-min candles for ${symbol}`);
    return candles;
  } catch (error) {
    logger.error(`Failed to fetch 5-min candles for ${symbol}`, error as Error);
    throw error;
  }
}

// Fetch 1-minute candles for a symbol (used for breakout and FVG detection)
// Returns candles for a specific date
export async function fetch1MinCandles(
  symbol: string,
  date: string,
): Promise<Candle[]> {
  try {
    await applyRateLimit();

    logger.debug(`Fetching 1-min candles for ${symbol} on ${date}`);

    const client = getAlpacaClient();

    // Calculate start and end times for the trading day
    const startTime = `${date}T09:30:00-05:00`; // Market open EST
    const endTime = `${date}T16:00:00-05:00`; // Market close EST

    // Fetch bars using Alpaca's getBarsV2 API
    const bars = client.getBarsV2(symbol, {
      start: startTime,
      end: endTime,
      timeframe: "1Min",
      feed: "sip", // SIP feed = consolidated real-time data
      limit: 10000,
    });

    // Collect bars into array
    const candles: Candle[] = [];
    for await (const bar of bars) {
      candles.push({
        symbol,
        timestamp: new Date(bar.Timestamp),
        open: bar.OpenPrice,
        high: bar.HighPrice,
        low: bar.LowPrice,
        close: bar.ClosePrice,
        volume: bar.Volume,
        vwap: (bar as any).VWAP || (bar as any).VWAPPrice, // Volume-weighted average price (if available)
        tradeCount: (bar as any).TradeCount || (bar as any).n, // Number of trades (if available)
      });
    }

    logger.debug(`Fetched ${candles.length} 1-min candles for ${symbol}`);
    return candles;
  } catch (error) {
    logger.error(`Failed to fetch 1-min candles for ${symbol}`, error as Error);
    throw error;
  }
}

// Fetch daily candles for a symbol (used for previous close and gap detection)
// Returns the most recent N daily candles
export async function fetchDailyCandles(
  symbol: string,
  numDays: number,
): Promise<Candle[]> {
  try {
    await applyRateLimit();

    logger.debug(`Fetching ${numDays} daily candles for ${symbol}`);

    const client = getAlpacaClient();

    // Calculate date range (from N days ago to today)
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - numDays - 10); // Extra buffer for weekends

    const startTime = fromDate.toISOString();
    const endTime = toDate.toISOString();

    // Fetch bars using Alpaca's getBarsV2 API
    const bars = client.getBarsV2(symbol, {
      start: startTime,
      end: endTime,
      timeframe: "1Day",
      feed: "sip", // SIP feed = consolidated data
      limit: 10000,
    });

    // Collect bars into array
    const candles: Candle[] = [];
    for await (const bar of bars) {
      candles.push({
        symbol,
        timestamp: new Date(bar.Timestamp),
        open: bar.OpenPrice,
        high: bar.HighPrice,
        low: bar.LowPrice,
        close: bar.ClosePrice,
        volume: bar.Volume,
      });
    }

    logger.debug(`Fetched ${candles.length} daily candles for ${symbol}`);
    return candles;
  } catch (error) {
    logger.error(`Failed to fetch daily candles for ${symbol}`, error as Error);
    throw error;
  }
}
