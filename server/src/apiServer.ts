// apiServer.ts - REST API server for the SignalFlow web dashboard
// Exposes the same capabilities as the Discord bot commands via HTTP endpoints.
// The frontend (web/) calls these endpoints to display data and control the bot.
// Runs on API_PORT (default 3001) alongside the Discord bot on the same process.

import express, { Request, Response, NextFunction } from "express";
import * as path from "path";
import * as fs from "fs";
import config from "./config";
import * as logger from "./logger";
import * as state from "./state";
import * as paperBroker from "./paperBroker";
import * as timeUtils from "./timeUtils";
import { runBacktestProgrammatic } from "./backtester";

// the runner controls are set by main.ts after the runner is created
// same pattern as discordBot.ts
let runnerControls: {
  start: () => Promise<void>;
  stop: () => void;
  getStatus: () => string;
} | null = null;

// set runner controls (called by main.ts)
export function setApiRunnerControls(controls: typeof runnerControls): void {
  runnerControls = controls;
}

// read the raw API key from env (separate from Alpaca keys - just a shared secret)
function getApiKey(): string {
  return process.env.API_KEY || "";
}

// middleware: check the x-api-key header on mutation endpoints
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = getApiKey();
  // if no API_KEY is configured, skip auth (open mode)
  if (!key) {
    next();
    return;
  }
  const provided = req.headers["x-api-key"];
  if (provided !== key) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// middleware: add CORS headers so the Firebase-hosted frontend can call us
function corsHeaders(req: Request, res: Response, next: NextFunction): void {
  // allow any origin for now - you can lock this down to your Firebase domain later
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  // handle preflight OPTIONS request from browser
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
}

// start the Express API server - called from main.ts
export function startApiServer(): void {
  const app = express();
  const port = parseInt(process.env.API_PORT || "3001", 10);

  // parse JSON request bodies and apply CORS to all routes
  app.use(express.json());
  app.use(corsHeaders);

  // ---- READ ENDPOINTS (no auth required - just data) ----

  // GET /status - bot mode, runner status, open positions, account equity
  app.get("/status", (_req: Request, res: Response) => {
    const info = config.mode === "PAPER" ? paperBroker.getAccountInfo() : null;
    const status = runnerControls ? runnerControls.getStatus() : "Not initialized";

    res.json({
      mode: config.mode,
      status,
      equity: info ? info.equity : null,
      cash: info ? info.cash : null,
      positions: info ? info.positions : [],
    });
  });

  // GET /balance - all-time P&L stats and per-symbol breakdown
  app.get("/balance", (_req: Request, res: Response) => {
    const stats = state.loadAllTimeStats();
    const info = config.mode === "PAPER" ? paperBroker.getAccountInfo() : null;

    res.json({
      equity: info ? info.equity : null,
      cash: info ? info.cash : null,
      allTimeStats: stats.allTimeStats,
      symbolStats: stats.symbolStats,
      lastUpdated: stats.lastUpdated,
    });
  });

  // GET /summary - today's trade history and rejection summary
  app.get("/summary", (_req: Request, res: Response) => {
    const today = timeUtils.getTodayDateString();
    const history = state.loadTradeHistory(today);
    const rejections = state.getRejectionSummary(today);

    res.json({
      date: today,
      trades: history ? history.trades : [],
      rejections,
    });
  });

  // GET /strategies - current contents of strategies.json (symbols, params, etc.)
  app.get("/strategies", (_req: Request, res: Response) => {
    try {
      const filePath = path.join(process.cwd(), "strategies.json");
      const raw = fs.readFileSync(filePath, "utf8");
      res.json(JSON.parse(raw));
    } catch (error) {
      res.status(500).json({ error: "Could not read strategies.json" });
    }
  });

  // ---- MUTATION ENDPOINTS (require API key) ----

  // POST /backtest - run a historical backtest
  // body: { from: "YYYY-MM-DD", to: "YYYY-MM-DD", strategy?: string }
  app.post("/backtest", requireApiKey, async (req: Request, res: Response) => {
    const { from, to, strategy } = req.body;

    // validate required fields
    if (!from || !to) {
      res.status(400).json({ error: "Missing required fields: from, to" });
      return;
    }

    try {
      logger.normal(`API: running backtest from ${from} to ${to}`);
      const result = await runBacktestProgrammatic(from, to, strategy);
      res.json(result);
    } catch (error) {
      logger.error("API backtest error", error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // PUT /strategies/symbols - add or remove a symbol from strategies.json
  // body: { strategyId: string, symbol: string, action: "add" | "remove" }
  app.put("/strategies/symbols", requireApiKey, (req: Request, res: Response) => {
    const { strategyId, symbol, action } = req.body;

    // validate
    if (!strategyId || !symbol || !action) {
      res.status(400).json({ error: "Missing required fields: strategyId, symbol, action" });
      return;
    }
    if (action !== "add" && action !== "remove") {
      res.status(400).json({ error: "action must be 'add' or 'remove'" });
      return;
    }

    try {
      const filePath = path.join(process.cwd(), "strategies.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const file = JSON.parse(raw);

      // find the target strategy
      const strat = file.strategies.find((s: any) => s.id === strategyId);
      if (!strat) {
        res.status(404).json({ error: `Strategy '${strategyId}' not found` });
        return;
      }

      const upperSymbol = symbol.toUpperCase();

      if (action === "add") {
        // don't add duplicates
        if (!strat.symbols.includes(upperSymbol)) {
          strat.symbols.push(upperSymbol);
        }
      } else {
        // remove the symbol
        strat.symbols = strat.symbols.filter((s: string) => s !== upperSymbol);
      }

      // write back to disk
      fs.writeFileSync(filePath, JSON.stringify(file, null, 2), "utf8");
      logger.normal(`API: ${action} symbol ${upperSymbol} in strategy ${strategyId}`);

      res.json({ success: true, symbols: strat.symbols });
    } catch (error) {
      logger.error("API symbol update error", error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // POST /restart - stop and restart the strategy runner
  app.post("/restart", requireApiKey, async (req: Request, res: Response) => {
    if (!runnerControls) {
      res.status(503).json({ error: "Runner controls not available" });
      return;
    }

    try {
      logger.normal("API: restart requested");
      runnerControls.stop();
      // brief pause to let the old runner wind down
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await runnerControls.start();
      res.json({ success: true, message: "Runner restarted" });
    } catch (error) {
      logger.error("API restart error", error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // start listening
  app.listen(port, () => {
    logger.normal(`API server listening on port ${port}`);
  });
}
