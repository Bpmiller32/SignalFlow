# SignalFlow Refactor Log

Work log for AI agents and future developers.
When picking up this project, read this FIRST.

---

## 2026-04-06 - Strategy Interface & Modular Architecture (Phase 1)

### What was done
- Created IStrategy interface for pluggable strategy implementations
- Created strategies.json for declarative JSON-driven strategy configuration
- Extracted all ORB+FVG decision logic from main.ts into ORBStrategy class
- Built StrategyRunner to orchestrate strategies loaded from JSON config
- Simplified main.ts to just create a StrategyRunner and start it
- Added new types to types.ts (StrategyConfig, result interfaces, etc.)

### New files
- `REFACTOR_LOG.md` - this file, work log for AI agents
- `strategies.json` - JSON config defining which strategies run with what params
- `src/strategies/IStrategy.ts` - Strategy interface that all strategies implement
- `src/strategies/orbStrategy.ts` - ORB+FVG strategy class (extracted from main.ts)
- `src/strategyRunner.ts` - Loads JSON config, creates strategies, runs market lifecycle

### Modified files
- `src/types.ts` - Added StrategyConfig and related types at the bottom
- `src/main.ts` - Rewritten to use StrategyRunner (old logic moved to orbStrategy)

### Files NOT changed (still work as before)
- `src/config.ts` - Still loads .env for global config (API keys, Discord, mode)
- `src/strategy.ts` - Pure functions for ORB/FVG math, called by ORBStrategy
- `src/filters.ts` - Pure functions for signal grading, called by ORBStrategy
- `src/positionSizer.ts` - Pure functions for sizing, called by ORBStrategy
- `src/paperBroker.ts` - Paper trading execution, called by StrategyRunner
- `src/discord.ts` - Discord notifications, called by StrategyRunner
- `src/state.ts` - File persistence, called by StrategyRunner
- `src/alpacaData.ts` - Alpaca data fetching, called by StrategyRunner
- `src/timeUtils.ts` - Time utilities, called by StrategyRunner
- `src/logger.ts` - Logging, called everywhere
- `backtest-today.ts` - Still works (imports unchanged modules)

### Architecture overview
```
strategies.json → StrategyRunner → IStrategy (interface)
                                      ↓
                                  ORBStrategy (implementation)
                                      ↓
                        strategy.ts / filters.ts / positionSizer.ts (pure functions)
```

- `strategies.json` defines WHAT to run (strategy type, symbols, params)
- `StrategyRunner` handles the HOW (market timing, candle fetching, trade execution)
- `IStrategy` is the contract between runner and strategy
- `ORBStrategy` makes decisions, runner executes them
- Existing pure-function modules are unchanged, just called from ORBStrategy now

### How to add a new strategy
1. Create `src/strategies/myStrategy.ts` implementing IStrategy
2. Add a case for your strategy type in `src/strategyRunner.ts` createStrategy()
3. Add a config block in `strategies.json` with type matching your case
4. Run it

### What still needs to be done (future phases)
- [x] Phase 2: Discord channel routing per strategy (DONE - see below)
- [x] Phase 3: Proper backtester (DONE - see below)
- [ ] Phase 4: Additional strategy implementations (mean reversion, VWAP, etc.)
- [ ] Phase 5: Live mode (Alpaca) order execution integration
- [ ] (Low priority) Unit tests for code correctness if ever needed

### Test run (2026-04-06)
- TypeScript compiles clean: `npx tsc --noEmit` exit code 0
- `npm start` runs successfully: loads strategies.json, initializes 7 symbols, recovers state
- Alpaca API returned 403 (subscription expired or Sunday) - code itself works correctly
- Discord webhook calls succeed (startup notification sent)
- Full lifecycle runs: startup → wait for market → capture ranges → monitor → shutdown

### Setup notes
- The env file is named `env` (no dot), but dotenv loads `.env`
- Must copy: `cp env .env` before running
- `.env.example` was created as a template
- strategies.json was synced to match the user's actual env settings

---

## 2026-04-06 - Discord Per-Strategy Channel Routing (Phase 2)

### What was done
- Added `notifications` section to StrategyConfig and strategies.json
- Each strategy specifies env var names for trades/system/errors webhooks
- discord.ts functions now accept optional webhookUrl override parameter
- StrategyRunner resolves env var names to URLs at startup
- Per-strategy calls (trade entry, trade exit, opening range, skip) use strategy's webhooks
- Global calls (startup, shutdown, market status) fall back to .env defaults

### How to route a strategy to different Discord channels
1. Create new Discord webhooks in the channels you want
2. Add the webhook URLs to your `.env` file with custom names:
   ```
   DISCORD_WEBHOOK_TRADES_V2=https://discord.com/api/webhooks/...
   DISCORD_WEBHOOK_SYSTEM_V2=https://discord.com/api/webhooks/...
   ```
3. Point the strategy to them in `strategies.json`:
   ```json
   "notifications": {
     "trades": "DISCORD_WEBHOOK_TRADES_V2",
     "system": "DISCORD_WEBHOOK_SYSTEM_V2",
     "errors": "DISCORD_WEBHOOK_ERRORS"
   }
   ```
4. Different strategies can point to different channels

### Files changed
- `src/types.ts` - Added NotificationConfig type, added notifications to StrategyConfig
- `src/discord.ts` - Added optional webhookUrl parameter to all public functions
- `src/strategyRunner.ts` - Added resolveWebhooks(), passes resolved URLs to discord calls
- `strategies.json` - Added notifications section with env var names

---

## 2026-04-06 - Historical Strategy Backtester (Phase 3)

### What was done
- Built `src/backtester.ts` - replays historical market data through IStrategy interface
- Uses same `strategies.json` config as live trading (same strategy, same params)
- Full lifecycle: opening range eval → candle processing → signal generation → position sizing → position management → exit
- Simulates partial exits, trailing stops, stop loss, take profit, end-of-day closes
- Computes stats: win rate, total P&L, max drawdown, profit factor, avg holding time, per-symbol breakdown
- Outputs results to console (formatted table) and saves to `data/backtest-{from}-to-{to}.json`
- Added `npm run backtest` script to package.json

### How to run a backtest
```bash
# basic usage (uses first enabled strategy from strategies.json)
npm run backtest -- 2026-01-27 2026-01-30

# specify a strategy by id
npm run backtest -- 2026-01-27 2026-01-30 orb-fvg-default
```

### What it does NOT do (vs live)
- No Discord notifications (silent)
- No state file persistence (clean each day)
- No paper broker (inline simulation)
- Uses candle timestamps for cutoff checks (not wall clock)
- Requires Alpaca API access for historical data

### Files added/changed
- `src/backtester.ts` - the backtester (new)
- `package.json` - added `backtest` script
- `backtest-today.ts` - old prototype, still exists but superseded by backtester.ts

### Known limitations
- Only one strategy type implemented (opening-range-breakout)
- Live mode (Alpaca order execution) still not implemented, only paper trading
- If two strategies list the same symbol, they will conflict on state files
- Strategies run sequentially in one loop, not parallel
- Requires active Alpaca API subscription for historical data fetching
- No market holiday calendar (may try to fetch data for holidays and get empty results)
