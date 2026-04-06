// main.ts - Entry point for SignalFlow
// Creates a StrategyRunner, loads strategies from JSON, and runs the trading session.
// All strategy logic is in src/strategies/. All orchestration is in strategyRunner.ts.
// This file is intentionally tiny - it just wires things together and starts.

import * as path from "path";
import * as logger from "./logger";
import { StrategyRunner } from "./strategyRunner";

// path to the strategies JSON config
const STRATEGIES_PATH = path.join(process.cwd(), "strategies.json");

async function main(): Promise<void> {
  try {
    // create the runner
    const runner = new StrategyRunner();

    // load strategies from JSON
    runner.loadStrategies(STRATEGIES_PATH);

    // run the full trading session (blocks until market close)
    await runner.run();
  } catch (error) {
    logger.error("Unhandled error in main", error as Error);
    process.exit(1);
  }
}

// start
main().catch((error) => {
  logger.error("Fatal error", error as Error);
  process.exit(1);
});
