// registry.ts - Strategy Registry
// Register all available strategy types here. Adding a new strategy is ONE line:
//   1. Import your strategy class
//   2. Add it to the registry map below
// Then set "type": "your-strategy-type" in strategies.json and it works
// in both live trading and backtesting automatically.

import { IStrategy } from "./IStrategy";
import { StrategyConfig, Config } from "../types";
import { ORBStrategy } from "./orbStrategy";

// strategy constructor type - takes a strategy config and global config, returns an IStrategy
type StrategyConstructor = new (config: StrategyConfig, globalConfig: Config) => IStrategy;

// ---- STRATEGY REGISTRY ----
// format: "type-name-from-json": StrategyClass
// to add a new strategy:
//   1. Create src/strategies/yourStrategy.ts implementing IStrategy
//   2. Import it above
//   3. Add: "your-type": YourStrategy
//   4. Set "type": "your-type" in your strategies.json entry

const strategyRegistry: Record<string, StrategyConstructor> = {
  "opening-range-breakout": ORBStrategy,
  // add new strategies below:
  // "mean-reversion": MeanReversionStrategy,
  // "vwap-bounce": VWAPBounceStrategy,
};

// create a strategy instance from its config type (used by both runner and backtester)
export function createStrategy(stratConfig: StrategyConfig, globalConfig: Config): IStrategy {
  const Constructor = strategyRegistry[stratConfig.type];
  if (!Constructor) {
    const available = Object.keys(strategyRegistry).join(", ");
    throw new Error(
      `Unknown strategy type: "${stratConfig.type}". ` +
      `Available types: [${available}]. ` +
      `Register new types in src/strategies/registry.ts`
    );
  }
  return new Constructor(stratConfig, globalConfig);
}

// get all registered strategy type names
export function getRegisteredTypes(): string[] {
  return Object.keys(strategyRegistry);
}
