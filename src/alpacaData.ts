// alpacaData.ts - Alpaca market data client
// Fetches 5-min candles (opening range), 1-min candles (breakout/FVG detection),
// and daily candles (previous close/gap detection) from Alpaca's API.

import Alpaca from "@alpacahq/alpaca-trade-api";
import { fromZonedTime } from "date-fns-tz";
import config from "./config";
import * as logger from "./logger";
import { Candle } from "./types";

// convert a date string (YYYY-MM-DD) and a time string (HH:MM) in New York time
// to a UTC ISO string - handles EST vs EDT automatically
function nyToUtc(date: string, time: string): string {
  return fromZonedTime(new Date(`${date}T${time}:00`), "America/New_York").toISOString();
}

// ---- ALPACA CLIENT INITIALIZATION ----

// lazily-initialized alpaca client instance
let alpacaClient: Alpaca;

// get or create the alpaca client
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

// ---- RATE LIMITING ----

// track last request time for rate limiting
let lastRequestTime = 0;

// minimum ms between requests (50ms = 20 req/sec)
const MIN_REQUEST_INTERVAL_MS = 50;

// sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// wait if needed to avoid exceeding rate limits
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

// ---- CANDLE FETCHING ----

// fetch 5-minute candles for a symbol on a given date (used for opening range)
export async function fetch5MinCandles(
  symbol: string,
  date: string,
): Promise<Candle[]> {
  try {
    await applyRateLimit();

    logger.debug(`Fetching 5-min candles for ${symbol} on ${date}`);

    const client = getAlpacaClient();

    // market open to close in New York time (handles EST vs EDT automatically)
    const startTime = nyToUtc(date, "09:30");
    const endTime = nyToUtc(date, "16:00");

    // fetch bars using alpaca's getBarsV2 API
    const bars = client.getBarsV2(symbol, {
      start: startTime,
      end: endTime,
      timeframe: "5Min",
      feed: "sip", // SIP feed = consolidated real-time data
      limit: 10000,
    });

    // collect bars from async iterator into array
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
        vwap: (bar as any).VWAP || (bar as any).VWAPPrice,
        tradeCount: (bar as any).TradeCount || (bar as any).n,
      });
    }

    logger.debug(`Fetched ${candles.length} 5-min candles for ${symbol}`);
    return candles;
  } catch (error) {
    logger.error(`Failed to fetch 5-min candles for ${symbol}`, error as Error);
    throw error;
  }
}

// fetch 1-minute candles for a symbol on a given date (used for breakout and FVG detection)
export async function fetch1MinCandles(
  symbol: string,
  date: string,
): Promise<Candle[]> {
  try {
    await applyRateLimit();

    logger.debug(`Fetching 1-min candles for ${symbol} on ${date}`);

    const client = getAlpacaClient();

    // market open to close in New York time (handles EST vs EDT automatically)
    const startTime = nyToUtc(date, "09:30");
    const endTime = nyToUtc(date, "16:00");

    // fetch bars using alpaca's getBarsV2 API
    const bars = client.getBarsV2(symbol, {
      start: startTime,
      end: endTime,
      timeframe: "1Min",
      feed: "sip", // SIP feed = consolidated real-time data
      limit: 10000,
    });

    // collect bars from async iterator into array
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
        vwap: (bar as any).VWAP || (bar as any).VWAPPrice,
        tradeCount: (bar as any).TradeCount || (bar as any).n,
      });
    }

    logger.debug(`Fetched ${candles.length} 1-min candles for ${symbol}`);
    return candles;
  } catch (error) {
    logger.error(`Failed to fetch 1-min candles for ${symbol}`, error as Error);
    throw error;
  }
}

// fetch daily candles for a symbol (used for previous close and gap detection)
// asOfDate: optional date to fetch candles relative to (backtester uses this for historical data)
export async function fetchDailyCandles(
  symbol: string,
  numDays: number,
  asOfDate?: string,
): Promise<Candle[]> {
  try {
    await applyRateLimit();

    logger.debug(`Fetching ${numDays} daily candles for ${symbol}${asOfDate ? ` as of ${asOfDate}` : ""}`);

    const client = getAlpacaClient();

    // calculate date range with extra buffer for weekends
    const toDate = asOfDate ? new Date(`${asOfDate}T00:00:00-05:00`) : new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - numDays - 10);

    const startTime = fromDate.toISOString();
    const endTime = toDate.toISOString();

    // fetch bars using alpaca's getBarsV2 API
    const bars = client.getBarsV2(symbol, {
      start: startTime,
      end: endTime,
      timeframe: "1Day",
      feed: "sip", // SIP feed = consolidated data
      limit: 10000,
    });

    // collect bars from async iterator into array
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
