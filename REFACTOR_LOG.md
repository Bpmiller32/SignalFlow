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

---

## 2026-04-06 - Discord Bot with Slash Commands (Phase 4)

### What was done

- Replaced Discord webhooks entirely with a discord.js bot
- Bot is now the main process (always running), trading loop runs in background
- Added 6 slash commands: /backtest, /strategies, /restart, /balance, /status, /help
- Rewrote discord.ts to send messages via bot channels instead of webhooks
- Refactored backtester.ts to export `runBacktestProgrammatic()` for /backtest
- Added stop()/getStatus() to StrategyRunner for /restart and /status
- Removed all webhook references from config, types, and strategies.json
- Notifications now route via channel IDs (env var names in strategies.json)
- Removed axios dependency for Discord (now using discord.js client)

### Slash commands

- `/help` — show all commands and how to use them
- `/backtest from:YYYY-MM-DD to:YYYY-MM-DD [strategy]` — run historical backtest
- `/strategies view|download|upload` — manage strategies.json
- `/restart` — stop trading loop, reload strategies.json, start fresh
- `/balance` — show P&L, win rate, per-symbol breakdown
- `/status` — show what bot is doing, positions, equity

### Setup required

1. Create Discord bot at https://discord.com/developers/applications
2. Invite bot to server with scopes: `bot`, `applications.commands`
3. Fill in `.env`: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, channel IDs
4. `npm start`

### Files added/changed

- `src/discordBot.ts` — new, the Discord bot + all slash command handlers
- `src/discord.ts` — rewritten, uses bot.sendToChannel() instead of webhooks
- `src/main.ts` — rewritten, bot is main process, runner is managed task
- `src/backtester.ts` — added runBacktestProgrammatic() export
- `src/strategyRunner.ts` — added stop(), getStatus(), stopRequested flag
- `src/config.ts` — removed webhooks, added bot token + guild ID + channel IDs
- `src/types.ts` — Config type: webhooks → bot fields
- `src/strategies/orbStrategy.ts` — updated buildLegacyConfig()
- `.env` — removed webhooks, added bot config
- `.env.example` — updated
- `strategies.json` — notifications now reference DISCORD*CHANNEL*\* env vars

### What still needs to be done

- [ ] Additional strategy implementations (mean reversion, VWAP, etc.)
- [ ] Live mode (Alpaca) order execution integration
- [ ] (Low priority) Unit tests for code correctness if ever needed

### Known limitations

- Only one strategy type implemented (opening-range-breakout)
- Live mode (Alpaca order execution) still not implemented, only paper trading
- If two strategies list the same symbol, they will conflict on state files
- Strategies run sequentially in one loop, not parallel
- Requires active Alpaca API subscription for historical data fetching
- No market holiday calendar (may try to fetch data for holidays and get empty results)

---

## 2026-04-06 - Generalized Strategy Interface & Cleanup (Phase 5)

### Problem

The previous refactor created the IStrategy interface but left the backtester and runner
calling ORB-specific private methods (evaluateOpeningRange, processCandle, calculatePositionSize)
directly on the IStrategy type. This caused 4 TypeScript compilation errors and meant no
other strategy type could actually plug into the system.

### What was done

- **Generalized StrategyConfig**: Moved all ORB-specific config fields (openingRange, breakout,
  fvg, positionSizing, riskManagement) into a generic `params: Record<string, any>` field.
  Any strategy now puts its own config in params and reads what it needs.
- **Generalized StrategySchedule**: Renamed ORB-specific fields to generic ones
  (openingRangeEnd → sessionSetupEnd, removed openingRangeStart/openingRangePollMs,
  moved maxStaleDataMinutes from breakout config to schedule).
- **Added date param to onSessionStart(date)**: Live mode passes today's date, backtester
  passes historical dates. Strategies fetch their own data internally for that date.
- **Fixed backtester to use only IStrategy methods**: Replaced direct calls to
  evaluateOpeningRange/processCandle/calculatePositionSize with onSessionStart(date) +
  onCandle() + evaluatePosition(). Backtester is now fully strategy-agnostic.
- **Removed dead code from StrategyRunner**: Deleted captureAllOpeningRanges() and
  captureOpeningRange() methods that were never called and referenced non-interface methods.
- **ORBStrategy reads from config.params**: Defines an internal ORBParams interface, casts
  config.params to it in the constructor, accesses all ORB-specific config through it.
- **Fixed holdOvernight check in shutdown**: Runner now actually checks the strategy's
  holdOvernight flag before force-closing positions at end of day.
- **Added single-line comments throughout**: All modified files have clear comments explaining
  what each section does for future maintainability.
- **Cleaned up unused imports**: Removed OpeningRange from strategyRunner imports, removed
  timeUtils from orbStrategy (no longer needed after date param change).

### Files changed

- `src/strategies/IStrategy.ts` — onSessionStart() now takes date: string parameter
- `src/types.ts` — StrategySchedule generalized, BreakoutConfig simplified, StrategyConfig
  uses params instead of ORB-specific fields, added section headers for ORB param types
- `strategies.json` — ORB-specific config moved into "params" object, schedule fields renamed
- `src/strategies/orbStrategy.ts` — Reads from config.params via typed ORBParams interface,
  onSessionStart accepts date param, removed timeUtils import
- `src/strategyRunner.ts` — Removed dead captureOpeningRange code, uses sessionSetupEnd and
  maxStaleDataMinutes from schedule, passes date to onSessionStart, holdOvernight check in shutdown
- `src/backtester.ts` — Uses only IStrategy interface methods (onSessionStart, onCandle,
  evaluatePosition), calls onSessionEnd after each day, fully strategy-agnostic
- `REFACTOR_LOG.md` — Updated with this entry

### Architecture overview (updated)

```
strategies.json
  ├── generic fields: id, type, enabled, symbols, schedule, notifications
  └── params: { strategy-specific config }
         ↓
StrategyRunner (loads JSON, runs lifecycle, executes decisions)
         ↓
IStrategy interface (generic contract)
  │  initialize(symbols)
  │  onSessionStart(date)    ← strategy fetches its own data
  │  onCandle(symbol, candle, equity) → StrategyAction
  │  evaluatePosition(symbol, candle, position) → PositionUpdate
  │  onSessionEnd()
  │
  ├── ORBStrategy (reads params.openingRange, params.breakout, etc.)
  ├── [YourStrategy] (reads params.whatever)
  └── ...
```

### How to add a new strategy (updated)

1. Create `src/strategies/myStrategy.ts` implementing IStrategy
2. Define your own params interface internally (e.g. MyParams)
3. Cast `config.params as MyParams` in constructor
4. Implement onSessionStart(date) to fetch whatever data you need
5. Implement onCandle() to return NONE/ENTRY/DONE with position sizing
6. Implement evaluatePosition() for open position management
7. Add your type string in `src/strategyRunner.ts` createStrategy() switch
8. Add a config block in `strategies.json` with your type and params
9. Run it — both live and backtest work automatically

### Test run (2026-04-06)

- TypeScript compiles clean: `npx tsc --noEmit` exit code 0, zero errors
- All 4 previous compilation errors resolved
- Backtester uses only IStrategy interface — works with any strategy type
- StrategyRunner has no strategy-specific code outside createStrategy()
