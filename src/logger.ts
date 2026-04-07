// logger.ts - Simple logging system
// Provides normal, debug, and error logging to console and file.
// All logs are written to data/logs/ directory with daily rotation.

import * as fs from "fs";
import * as path from "path";
import config from "./config";

// ---- SETUP ----

// directory where log files are stored
const LOG_DIR = path.join(process.cwd(), "data", "logs");

// ensure log directory exists
function ensureLogDirectory(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// get current date string for log file names (YYYY-MM-DD in EST)
function getCurrentDateString(): string {
  const estDate = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const date = new Date(estDate);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// get current timestamp string for log entries (HH:MM:SS)
function getTimestampString(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

// write a log entry to a file
function writeToFile(filename: string, message: string): void {
  try {
    ensureLogDirectory();
    const filePath = path.join(LOG_DIR, filename);
    const timestamp = getTimestampString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(filePath, logEntry, "utf8");
  } catch (error) {
    console.error("Failed to write to log file:", error);
  }
}

// ---- CORE LOGGING FUNCTIONS ----

// log a normal-level message (always shown)
export function normal(message: string): void {
  const timestamp = getTimestampString();
  console.log(`[${timestamp}] ${message}`);
  
  const dateString = getCurrentDateString();
  writeToFile(`${dateString}.log`, message);
}

// log a debug-level message (only shown if LOG_LEVEL=debug)
export function debug(message: string): void {
  if (config.logLevel !== "debug") {
    return;
  }

  const timestamp = getTimestampString();
  console.log(`[${timestamp}] [DEBUG] ${message}`);
  
  const dateString = getCurrentDateString();
  writeToFile(`${dateString}.log`, `[DEBUG] ${message}`);
}

// log an error message (always shown, written to both daily and error logs)
export function error(message: string, err?: Error): void {
  const timestamp = getTimestampString();

  // build full error message with optional stack trace
  let fullMessage = `❌ ERROR: ${message}`;
  if (err) {
    fullMessage += `\n   ${err.message}`;
    if (config.logLevel === "debug" && err.stack) {
      fullMessage += `\n   Stack: ${err.stack}`;
    }
  }

  console.error(`[${timestamp}] ${fullMessage}`);

  // write to both the daily log and a separate error log
  const dateString = getCurrentDateString();
  writeToFile(`${dateString}.log`, fullMessage);
  writeToFile(`error-${dateString}.log`, fullMessage);
}

// log a section separator (for visual organization)
export function separator(): void {
  const line = "═".repeat(80);
  normal(line);
}

// ---- INITIALIZATION ----

// create log directory on module load
ensureLogDirectory();
