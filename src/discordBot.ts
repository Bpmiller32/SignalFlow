// discordBot.ts - Discord bot with slash commands
// Handles user interaction via Discord. Manages the StrategyRunner lifecycle.
// Commands: /backtest, /balance, /status, /help

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";
import config from "./config";
import * as logger from "./logger";
import * as state from "./state";
import * as paperBroker from "./paperBroker";
import { runBacktestProgrammatic } from "./backtester";

// the discord.js client
let client: Client | null = null;

// reference to the strategy runner controls (set by main.ts)
let runnerControls: {
  start: () => Promise<void>;
  stop: () => void;
  getStatus: () => string;
} | null = null;

// set the runner controls (called by main.ts after creating the runner)
export function setRunnerControls(controls: typeof runnerControls): void {
  runnerControls = controls;
}

// get the discord client (used by discordMessages.ts for sending messages)
export function getClient(): Client | null {
  return client;
}

// start the bot, register commands, listen for interactions
export async function startBot(): Promise<void> {
  const token = config.discordBotToken;
  const guildId = config.discordGuildId;

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await registerCommands(token, guildId);

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (error) {
      logger.error("Error handling discord command", error as Error);
      const reply = {
        content: `❌ Error: ${(error as Error).message}`,
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  });

  client.once(Events.ClientReady, async (c) => {
    logger.normal(`Discord bot logged in as ${c.user.tag}`);

    // try to set bot avatar from data/avatar.png
    const avatarPath = path.join(process.cwd(), "data", "avatar.png");
    if (fs.existsSync(avatarPath)) {
      try {
        await c.user.setAvatar(avatarPath);
        logger.normal("Discord bot avatar updated from data/avatar.png");
      } catch (error) {
        logger.debug(`Could not set avatar: ${(error as Error).message}`);
      }
    }
  });

  await client.login(token);
}

// send a message to a discord channel by ID
export async function sendToChannel(
  channelId: string,
  content: string,
): Promise<void> {
  if (!client || !channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      if (content.length <= 2000) {
        await (channel as TextChannel).send(content);
      } else {
        const chunks = splitMessage(content, 2000);
        for (const chunk of chunks) {
          await (channel as TextChannel).send(chunk);
        }
      }
    }
  } catch (error) {
    logger.error(`Failed to send to channel ${channelId}`, error as Error);
  }
}

// register all slash commands with discord
async function registerCommands(token: string, guildId: string): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("backtest")
      .setDescription("Run a historical backtest")
      .addStringOption((opt) =>
        opt
          .setName("from")
          .setDescription("Start date (YYYY-MM-DD)")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("to")
          .setDescription("End date (YYYY-MM-DD)")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("strategy")
          .setDescription("Strategy ID (optional)")
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName("balance")
      .setDescription("Show P&L summary and trade history"),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show what the bot is currently doing"),

    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show all available commands and how to use them"),
  ];

  const rest = new REST({ version: "10" }).setToken(token);
  const clientId = Buffer.from(token.split(".")[0], "base64").toString();
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands.map((c) => c.toJSON()),
  });

  logger.normal(
    `Registered ${commands.length} slash commands in guild ${guildId}`,
  );
}

// route a slash command to the right handler
async function handleCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  switch (interaction.commandName) {
    case "backtest":
      await handleBacktest(interaction);
      break;
    case "balance":
      await handleBalance(interaction);
      break;
    case "status":
      await handleStatus(interaction);
      break;
    case "help":
      await handleHelp(interaction);
      break;
  }
}

// ---- COMMAND HANDLERS ----

// /backtest - run a historical backtest
async function handleBacktest(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const fromDate = interaction.options.getString("from", true);
  const toDate = interaction.options.getString("to", true);
  const strategyId = interaction.options.getString("strategy") || undefined;

  // deferReply extends the interaction window to 15 minutes (vs 3 seconds default)
  // this is necessary because backtest fetches data from Alpaca which takes time
  await interaction.deferReply();

  try {
    const result = await runBacktestProgrammatic(fromDate, toDate, strategyId);
    const msg = formatBacktestResults(result);

    // discord has a 2000 char limit per message
    // send first chunk as editReply, rest as followUp messages
    const chunks = splitMessage(msg, 2000);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    // catch expired webhook token separately so we can log it clearly
    const errMsg = (error as Error).message || "";
    if (errMsg.includes("Webhook Token")) {
      logger.error("Backtest Discord reply expired - operation took too long");
    }
    try {
      await interaction.editReply(`❌ Backtest failed: ${errMsg}`);
    } catch (_e) {
      // interaction already expired, nothing we can do
    }
  }
}

// /balance - show P&L summary
async function handleBalance(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const stats = state.loadAllTimeStats();
  const accountInfo =
    config.mode === "PAPER" ? paperBroker.getAccountInfo() : null;
  const allTime = stats.allTimeStats;
  const pnlSign = allTime.totalPnL >= 0 ? "+" : "";
  const winRate =
    allTime.totalTrades > 0
      ? ((allTime.wins / allTime.totalTrades) * 100).toFixed(1)
      : "0.0";

  let msg = `💰 **BALANCE & P&L**\n`;
  msg += `══════════════════════════\n`;

  if (accountInfo) {
    msg += `**Account Balance:** $${accountInfo.equity.toFixed(2)}\n`;
    msg += `**Cash:** $${accountInfo.cash.toFixed(2)}\n`;
    msg += `══════════════════════════\n`;
  }

  msg += `**Total P&L:** ${pnlSign}$${allTime.totalPnL.toFixed(2)}\n`;
  msg += `**Total Trades:** ${allTime.totalTrades}\n`;
  msg += `**Wins:** ${allTime.wins} | **Losses:** ${allTime.losses}\n`;
  msg += `**Win Rate:** ${winRate}%\n`;

  if (allTime.totalTrades > 0) {
    msg += `**Best Trade:** ${allTime.bestTrade >= 0 ? "+" : ""}$${allTime.bestTrade.toFixed(2)}\n`;
    msg += `**Worst Trade:** ${allTime.worstTrade >= 0 ? "+" : ""}$${allTime.worstTrade.toFixed(2)}\n`;
    msg += `**Avg Win:** +$${allTime.averageWin.toFixed(2)}\n`;
    msg += `**Avg Loss:** $${allTime.averageLoss.toFixed(2)}\n`;
  }

  const symbolKeys = Object.keys(stats.symbolStats);
  if (symbolKeys.length > 0) {
    msg += `\n**PER-SYMBOL**\n`;
    msg += `──────────────────────────\n`;
    for (const sym of symbolKeys) {
      const s = stats.symbolStats[sym];
      const sPnlSign = s.totalPnL >= 0 ? "+" : "";
      const sWinRate =
        s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(0) : "0";
      msg += `${sym}: ${s.totalTrades} trades | ${sPnlSign}$${s.totalPnL.toFixed(2)} | ${sWinRate}% win\n`;
    }
  }

  await interaction.reply(msg);
}

// /status - show what bot is doing
async function handleStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  let msg = `🤖 **BOT STATUS**\n`;
  msg += `══════════════════════════\n`;
  msg += `**Mode:** ${config.mode}\n`;
  msg += `**Uptime:** Bot is running\n`;

  if (runnerControls) {
    msg += `**Trading:** ${runnerControls.getStatus()}\n`;
  } else {
    msg += `**Trading:** Not initialized\n`;
  }

  if (config.mode === "PAPER") {
    const info = paperBroker.getAccountInfo();
    msg += `**Equity:** $${info.equity.toFixed(2)}\n`;
    if (info.positions.length > 0) {
      msg += `\n**Open Positions:**\n`;
      for (const pos of info.positions) {
        msg += `  ${pos.symbol}: ${pos.side} ${pos.quantity} shares @ $${pos.entryPrice.toFixed(2)}\n`;
      }
    } else {
      msg += `**Positions:** None\n`;
    }
  }

  await interaction.reply(msg);
}

// /help - show all commands
async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const msg = `🤖 **SignalFlow Bot Commands**
══════════════════════════════

📊 **/backtest**
Run a historical backtest on past market data.
Example: \`/backtest from:2026-03-01 to:2026-04-01\`

💰 **/balance**
Show total P&L, win rate, per-symbol breakdown, and account balance.

🤖 **/status**
Show what the bot is doing right now (waiting, monitoring, positions, etc.)

❓ **/help**
This message.

══════════════════════════════
**How it works:**
The bot runs automated trading strategies during market hours (9:30 AM - 4:00 PM EST).
Strategies are defined in code (src/strategies/) and configured via strategies.json.
`;

  await interaction.reply(msg);
}

// ---- HELPERS ----

// format backtest results for discord
// returns an array of messages since the full output exceeds 2000 chars
function formatBacktestResults(result: any): string {
  const s = result.stats;
  const pnlSign = s.totalPnL >= 0 ? "+" : "";
  let msg = `📊 **BACKTEST RESULTS**\n`;
  msg += `══════════════════════════\n`;
  msg += `**Trades:** ${s.totalTrades} (${s.wins}W / ${s.losses}L)\n`;
  msg += `**Win Rate:** ${s.winRate.toFixed(1)}%\n`;
  msg += `**Total P&L:** ${pnlSign}$${s.totalPnL.toFixed(2)}\n`;
  msg += `**Max Drawdown:** -$${s.maxDrawdown.toFixed(2)}\n`;
  msg += `**Profit Factor:** ${s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)}\n`;
  msg += `**Avg Hold:** ${s.averageHoldingMinutes.toFixed(0)} min\n`;

  // capital requirements
  if (s.peakCapitalRequired) {
    msg += `\n**CAPITAL**\n`;
    msg += `──────────────────────────\n`;
    msg += `**Peak Capital Needed:** $${s.peakCapitalRequired.toFixed(2)}\n`;
    msg += `**Return on Capital:** ${s.returnOnCapital >= 0 ? "+" : ""}${s.returnOnCapital.toFixed(2)}%\n`;
    msg += `**Total Deployed:** $${s.totalCapitalDeployed.toFixed(2)}\n`;
  }

  // detailed per-symbol scorecard (sorted by P&L, best first)
  if (s.symbolStats && Object.keys(s.symbolStats).length > 0) {
    const sorted = Object.entries(s.symbolStats)
      .sort((a: any, b: any) => b[1].totalPnL - a[1].totalPnL);

    msg += `\n**TICKER SCORECARD**\n`;
    msg += `══════════════════════════\n`;

    for (const [sym, ss] of sorted) {
      const t = ss as any;
      const emoji = t.totalPnL > 0 ? "🟢" : t.totalPnL < 0 ? "🔴" : "⚪";
      const sp = t.totalPnL >= 0 ? "+" : "";
      const pfStr = t.profitFactor === Infinity ? "∞" : t.profitFactor.toFixed(2);

      msg += `\n${emoji} **${sym}**\n`;
      msg += `──────────────────────────\n`;

      // core performance
      msg += `**Trades:** ${t.trades} (${t.wins}W / ${t.losses}L) | **Win Rate:** ${t.winRate.toFixed(0)}%\n`;
      msg += `**P&L:** ${sp}$${t.totalPnL.toFixed(2)} | **Avg:** ${t.avgPnL >= 0 ? "+" : ""}$${t.avgPnL.toFixed(2)}/trade\n`;
      msg += `**Best:** +$${t.bestTrade.toFixed(2)} | **Worst:** $${t.worstTrade.toFixed(2)}\n`;

      // edge quality
      msg += `**Avg Win:** +$${t.avgWin.toFixed(2)} | **Avg Loss:** $${t.avgLoss.toFixed(2)} | **PF:** ${pfStr}\n`;

      // direction breakdown
      if (t.longs > 0 || t.shorts > 0) {
        const longStr = t.longs > 0 ? `${t.longs}L (${t.longWinRate.toFixed(0)}% win)` : "0L";
        const shortStr = t.shorts > 0 ? `${t.shorts}S (${t.shortWinRate.toFixed(0)}% win)` : "0S";
        msg += `**Sides:** ${longStr} | ${shortStr}\n`;
      }

      // timing and activity
      msg += `**Avg Hold:** ${t.avgHoldingMinutes.toFixed(0)} min | **Signal Rate:** ${t.signalRate.toFixed(1)}% of days\n`;

      // exit reasons
      if (t.exitReasons) {
        const reasonParts: string[] = [];
        for (const [reason, count] of Object.entries(t.exitReasons)) {
          reasonParts.push(`${reason}: ${count}`);
        }
        if (reasonParts.length > 0) {
          msg += `**Exits:** ${reasonParts.join(" | ")}\n`;
        }
      }
    }
  }

  return msg;
}

// split a long message into chunks respecting newlines
function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1) splitAt = maxLength;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}
