# SignalFlow

**Automated Day Trading Bot Framework with Pluggable Strategies**

A Discord-controlled trading bot that runs strategies against real market data via Alpaca. Designed so entire strategies live in `src/strategies/` and the core bot just executes them.

## Quick Start

```bash
cd server
npm install
cp .env.example .env  # Add your Alpaca API keys + Discord bot token
npx ts-node src/main.ts
```

## How It Works

SignalFlow is a **framework for day trading strategies**, not a single hard-coded strategy. The core bot handles:

- Market data fetching (Alpaca API)
- Trade execution (paper or live)
- Discord slash commands (`/backtest`, `/balance`, `/status`, `/help`)
- State persistence (crash recovery)
- Position management (stops, targets, trailing, partial exits)

Strategies are pluggable modules that make all the trading decisions. The bot just does what they say.

## Architecture

```
server/
├── src/                      ← Core bot (strategy-agnostic)
│   ├── main.ts               ← Entry point
│   ├── strategyRunner.ts     ← Orchestrates strategies, executes trades
│   ├── backtester.ts         ← Historical replay through IStrategy interface
│   ├── alpacaData.ts         ← Market data fetching
│   ├── paperBroker.ts        ← Paper trading simulator
│   ├── discordBot.ts         ← Discord slash commands
│   ├── discordMessages.ts    ← Notification formatting
│   ├── state.ts              ← File-based state persistence
│   ├── config.ts             ← Global config (.env loader)
│   ├── types.ts              ← All TypeScript types
│   ├── logger.ts             ← Logging
│   ├── timeUtils.ts          ← Market hours and timezone utilities
│   └── strategies/
│       ├── IStrategy.ts      ← Strategy interface (implement this)
│       ├── registry.ts       ← Strategy registry (register new strategies here)
│       ├── orbStrategy.ts    ← ORB+FVG strategy (decision-maker)
│       └── orbHelpers.ts     ← ORB pure functions (OR calc, FVG, sizing)
├── strategies.json           ← Strategy configuration
├── data/                     ← Runtime data (state, logs, backtest results)
└── web/                      ← React frontend (deployed to Firebase)
```

**Key principle:** Strategy-specific logic never leaks into the core bot. The core only talks to strategies through the `IStrategy` interface.

## Current Strategy: Opening Range Breakout + FVG

The included strategy (`orb-fvg-default`) does:

1. Captures opening range from the first 5-min candle (9:30-9:35 AM EST)
2. Waits for price to break above/below the range with volume confirmation
3. Confirms momentum with a 3-candle Fair Value Gap pattern
4. Enters a trade with calculated position sizing and stop/target
5. Manages the position with partial exits and trailing stops
6. One trade per symbol per day, closes everything by market close

Supports **inverse mode** (fade the breakout instead of following it) via `"inverseMode": true` in strategies.json.


The 20 Filters (Simplified Checklist) ✅

Phase 1 - Pre-Market (1 filter):

❌ Skip if earnings today (too unpredictable)
Phase 2 - Opening Range (4 filters): 2. ❌ Gap too big (>1.0%) 3. ❌ Range too small (<0.15%) 4. ❌ Range too big (>1.5%) 5. ❌ Weak setup (strength <5/10)

Phase 3 - Breakout (4 filters): 6. ❌ Low breakout volume (<1.2x) 7. ❌ Too quiet overall (<10k volume/min) 8. ❌ Stale data (>2 min old) 9. ❌ Took too long (>5 min to complete)

Phase 4 - FVG Pattern (6 filters): 10. ❌ Wrong direction 11. ❌ Body too small (<55%) 12. ❌ Range too small (<0.15%) 13. ❌ Close not committed (<25%) 14. ❌ Volume too low (<1.5x) 15. ❌ No gap between candles

Phase 5 - Execution (5 filters): 16. ❌ Weak signal (reduce size) 17. ❌ Weak opening (reduce size) 18. ❌ Too small (<$100) 19. ❌ Too big (>$10,000) 20. ❌ Can't buy partial shares

## Adding a New Strategy

1. Create `server/src/strategies/yourStrategy.ts` implementing `IStrategy`
2. Create `server/src/strategies/yourHelpers.ts` for pure functions (optional)
3. Register it in `server/src/strategies/registry.ts`:
   ```ts
   import { YourStrategy } from "./yourStrategy";
   // add to registry:
   "your-type": YourStrategy,
   ```
4. Add a config entry in `strategies.json` with `"type": "your-type"`

That's it. The backtester, live runner, and Discord commands all work automatically.

## Configuration

### `.env` — Global settings

```env
MODE=PAPER
ALPACA_API_KEY=your_key
ALPACA_SECRET_KEY=your_secret
ALPACA_BASE_URL=https://paper-api.alpaca.markets
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_server_id
DISCORD_CHANNEL_ID=your_channel_id
LOG_LEVEL=normal
```

### `strategies.json` — Strategy settings

All strategy-specific configuration lives here, not in `.env`. Each strategy entry has:

- `id` — unique name
- `type` — maps to a registered strategy class
- `enabled` — toggle on/off
- `symbols` — what tickers to trade
- `schedule` — timing (setup window, cutoff, polling interval)
- `params` — strategy-specific settings (position sizing, risk management, etc.)

## Discord Commands

| Command                                   | What it does                                         |
| ----------------------------------------- | ---------------------------------------------------- |
| `/backtest from:2026-01-01 to:2026-03-31` | Run a historical backtest with full ticker scorecard |
| `/balance`                                | Show P&L summary and account balance                 |
| `/status`                                 | Show what the bot is doing right now                 |
| `/help`                                   | List all commands                                    |

### Discord Bot Setup

**OAuth2 Scopes:** `bot`, `applications.commands`
**Bot Permissions:** `Send Messages`
**No privileged intents needed**

## Backtesting

Run from CLI:

```bash
cd server
npx ts-node src/backtester.ts 2026-01-01 2026-03-31
npx ts-node src/backtester.ts 2026-01-01 2026-03-31 orb-fvg-default
```

Or via Discord: `/backtest from:2026-01-01 to:2026-03-31`

Output includes:

- Overall performance (trades, win rate, P&L, profit factor, drawdown)
- **Capital requirements** (peak capital needed, return on capital)
- **Ticker Scorecard** — per-symbol breakdown with win rate, avg P&L, profit factor, long/short split, signal rate, and exit reasons
- **Ranking table** — sorted by P&L for quick keep/drop decisions
- Full trade log (CLI only)
- JSON results saved to `data/`

## Stack

- TypeScript + Node.js
- Alpaca API (market data + paper/live trading)
- Discord.js (slash command bot)
- JSON files (state persistence, no database needed)

## Philosophy

Simple. Readable. Self-documenting code with single-line comments explaining everything so you can understand it months later. No fancy abstractions — strategies are just classes with pure functions. The core bot is strategy-agnostic. Adding a new strategy should never require touching core files.
