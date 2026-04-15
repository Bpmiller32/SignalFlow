// main.ts - Entry point for SignalFlow
// The Discord bot is the main process. It starts first, then manages the trading loop.
// Slash commands (/backtest, /strategies, /restart, /balance, /status) are always available.
// The StrategyRunner runs in the background as a managed task.

import * as path from "path";
import * as logger from "./logger";
import { startBot, setRunnerControls } from "./discordBot";
import { startApiServer, setApiRunnerControls } from "./apiServer";
import { StrategyRunner } from "./strategyRunner";

// path to strategies JSON config
const STRATEGIES_PATH = path.join(process.cwd(), "strategies.json");

// current runner instance (null when stopped)
let runner: StrategyRunner | null = null;
let runnerPromise: Promise<void> | null = null;

// start the trading loop (called on startup and by /restart)
async function startRunner(): Promise<void> {
  runner = new StrategyRunner();
  runner.loadStrategies(STRATEGIES_PATH);
  runnerPromise = runner.run();
  // don't await - let it run in background
  runnerPromise.catch((err) => {
    logger.error("Runner error", err);
  });
}

// stop the trading loop (called by /restart)
function stopRunner(): void {
  if (runner) {
    runner.stop();
    runner = null;
    runnerPromise = null;
  }
}

// get runner status (called by /status)
function getRunnerStatus(): string {
  if (!runner) return "Not running";
  return runner.getStatus();
}

async function main(): Promise<void> {
  try {
    // start the discord bot first (always-on process)
    logger.normal("Starting Discord bot...");
    await startBot();

    // give the bot access to runner controls for slash commands
    setRunnerControls({
      start: startRunner,
      stop: stopRunner,
      getStatus: getRunnerStatus,
    });

    // start the REST API server for the web dashboard
    startApiServer();

    // give the API server access to runner controls as well
    setApiRunnerControls({
      start: startRunner,
      stop: stopRunner,
      getStatus: getRunnerStatus,
    });

    // start the trading loop
    await startRunner();

    logger.normal("SignalFlow is running. Use Discord slash commands or the web dashboard to control.");
  } catch (error) {
    logger.error("Fatal error in main", error as Error);
    process.exit(1);
  }
}

// start
main().catch((error) => {
  logger.error("Unhandled error", error as Error);
  process.exit(1);
});
