//==============================================================================
// TIMEUTILS.TS - TIME AND TIMEZONE UTILITIES
//==============================================================================
// This file handles all time-related operations including:
// - Working with EST (Eastern) time zone (market time)
// - Determining if market is open
// - Calculating market open/close times
// - Checking if we're within trading windows
//==============================================================================

import { toZonedTime, format } from "date-fns-tz";
import { addDays, isWeekend, setHours, setMinutes, setSeconds } from "date-fns";
import { MarketHours } from "./types";

//==============================================================================
// TIMEZONE CONSTANTS
//==============================================================================

const EST_TIMEZONE = "America/New_York"; // Eastern time (market time)

// Market hours in EST
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 30;
const MARKET_CLOSE_HOUR = 16;
const MARKET_CLOSE_MINUTE = 0;

//==============================================================================
// TIMEZONE CONVERSION
//==============================================================================

// Get current time in EST (market time)
export function getCurrentEstTime(): Date {
  return toZonedTime(new Date(), EST_TIMEZONE);
}

//==============================================================================
// TIME FORMATTING
//==============================================================================

// Format a date in EST timezone (HH:MM:SS)
export function formatEstTime(date: Date): string {
  return format(date, "HH:mm:ss", { timeZone: EST_TIMEZONE });
}

// Format a date in EST timezone with custom format
export function formatTimeEST(date: Date, formatStr: string): string {
  return format(date, formatStr, { timeZone: EST_TIMEZONE });
}

// Format a date as YYYY-MM-DD
export function formatDate(date: Date): string {
  return format(date, "yyyy-MM-dd", { timeZone: EST_TIMEZONE });
}

// Format a date with full timestamp (YYYY-MM-DD HH:MM:SS EST)
export function formatFullTimestamp(date: Date): string {
  return format(date, "yyyy-MM-dd HH:mm:ss zzz", { timeZone: EST_TIMEZONE });
}

//==============================================================================
// MARKET HOURS
//==============================================================================

// Get market open time for a given date (9:30 AM EST)
export function getMarketOpen(date: Date): Date {
  const estDate = toZonedTime(date, EST_TIMEZONE);
  let openTime = setHours(estDate, MARKET_OPEN_HOUR);
  openTime = setMinutes(openTime, MARKET_OPEN_MINUTE);
  openTime = setSeconds(openTime, 0);
  return openTime;
}

// Get market close time for a given date (4:00 PM EST)
export function getMarketClose(date: Date): Date {
  const estDate = toZonedTime(date, EST_TIMEZONE);
  let closeTime = setHours(estDate, MARKET_CLOSE_HOUR);
  closeTime = setMinutes(closeTime, MARKET_CLOSE_MINUTE);
  closeTime = setSeconds(closeTime, 0);
  return closeTime;
}

// Check if a given date is a weekend (markets are closed)
export function isMarketWeekend(date: Date): boolean {
  const estDate = toZonedTime(date, EST_TIMEZONE);
  return isWeekend(estDate);
}

// Check if market is currently open
export function isMarketOpen(): boolean {
  const now = getCurrentEstTime();

  // Market is closed on weekends
  if (isMarketWeekend(now)) {
    return false;
  }

  // Get today's open and close times
  const marketOpen = getMarketOpen(now);
  const marketClose = getMarketClose(now);

  // Check if current time is between open and close
  return now >= marketOpen && now < marketClose;
}

// Get market hours information (open/closed, next open, next close)
export function getMarketHours(): MarketHours {
  const now = getCurrentEstTime();
  const isOpen = isMarketOpen();

  let nextOpen: Date;
  let nextClose: Date;

  if (isOpen) {
    // Market is open now
    nextOpen = getMarketOpen(now); // Today's open (already passed)
    nextClose = getMarketClose(now); // Today's close (upcoming)
  } else {
    // Market is closed - find next open
    const todayOpen = getMarketOpen(now);
    const todayClose = getMarketClose(now);

    if (now < todayOpen && !isMarketWeekend(now)) {
      // Before today's open - next open is today
      nextOpen = todayOpen;
      nextClose = todayClose;
    } else {
      // After today's close or weekend - find next trading day
      let searchDate = addDays(now, 1);
      while (isMarketWeekend(searchDate)) {
        searchDate = addDays(searchDate, 1);
      }
      nextOpen = getMarketOpen(searchDate);
      nextClose = getMarketClose(searchDate);
    }
  }

  // Calculate hours until open/close
  const msUntilOpen = nextOpen.getTime() - now.getTime();
  const msUntilClose = nextClose.getTime() - now.getTime();
  const hoursUntilOpen = msUntilOpen / (1000 * 60 * 60);
  const hoursUntilClose = msUntilClose / (1000 * 60 * 60);

  return {
    isOpen,
    nextOpen,
    nextClose,
    hoursUntilOpen,
    hoursUntilClose,
  };
}

//==============================================================================
// STRATEGY TIMING
//==============================================================================

// Check if we're in the opening range capture window (9:30-9:35 AM EST)
export function isOpeningRangeWindow(): boolean {
  const now = getCurrentEstTime();
  const marketOpen = getMarketOpen(now);

  // Opening range window is 5 minutes after market open
  const rangeEnd = new Date(marketOpen.getTime() + 5 * 60 * 1000);

  return now >= marketOpen && now < rangeEnd;
}

// Check if we're past the strategy cutoff time (default 11:30 AM EST)
// After this time, no new trades should be entered
export function isPastStrategyCutoff(cutoffTime: string): boolean {
  const now = getCurrentEstTime();

  // Parse cutoff time (format: "HH:MM")
  const [hours, minutes] = cutoffTime.split(":").map(Number);

  let cutoff = setHours(now, hours);
  cutoff = setMinutes(cutoff, minutes);
  cutoff = setSeconds(cutoff, 0);

  return now >= cutoff;
}

// Get time until strategy cutoff in minutes
export function getMinutesUntilCutoff(cutoffTime: string): number {
  const now = getCurrentEstTime();

  // Parse cutoff time
  const [hours, minutes] = cutoffTime.split(":").map(Number);

  let cutoff = setHours(now, hours);
  cutoff = setMinutes(cutoff, minutes);
  cutoff = setSeconds(cutoff, 0);

  const msUntilCutoff = cutoff.getTime() - now.getTime();
  return Math.floor(msUntilCutoff / (1000 * 60));
}

// Check if we should wait for market to open
export function shouldWaitForMarketOpen(): boolean {
  return !isMarketOpen();
}

//==============================================================================
// DURATION CALCULATIONS
//==============================================================================

// Calculate duration between two dates in seconds
export function getDurationSeconds(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / 1000);
}

// Calculate duration between two dates in minutes
export function getDurationMinutes(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (1000 * 60));
}

// Format duration in seconds as human-readable string
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

//==============================================================================
// UTILITY FUNCTIONS
//==============================================================================

// Sleep for a given number of milliseconds
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Get date string for today in YYYY-MM-DD format (EST timezone)
export function getTodayDateString(): string {
  return formatDate(getCurrentEstTime());
}

// Parse a time string (HH:MM) and return Date object for today at that time (EST)
export function parseTimeToday(timeString: string): Date {
  const now = getCurrentEstTime();
  const [hours, minutes] = timeString.split(":").map(Number);

  let result = setHours(now, hours);
  result = setMinutes(result, minutes);
  result = setSeconds(result, 0);

  return result;
}

// Check if current time is before a target time (HH:MM format in EST)
export function isBeforeTime(current: Date, targetTime: string): boolean {
  const currentTimeStr = formatTimeEST(current, "HH:mm");
  return currentTimeStr < targetTime;
}
