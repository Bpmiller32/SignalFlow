// discordBot.ts - Discord bot with slash commands
// This is the interactive layer. Handles commands and sends messages to channels.
// The bot is the main process. It manages the StrategyRunner lifecycle.

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  AttachmentBuilder,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";
import config from "./config";
import * as logger from "./logger";
import * as state from "./state";
import * as paperBroker from "./paperBroker";

// backtester import (the runBacktest function)
import { runBacktestProgrammatic } from "./backtester";

// the discord.js client
let client: Client | null = null;

// reference to the strategy runner start/stop functions (set by main.ts)
let runnerControls: {
  start: () => Promise<void>;
  stop: () => void;
  getStatus: () => string;
} | null = null;

// set the runner controls (called by main.ts after creating the runner)
export function setRunnerControls(controls: typeof runnerControls): void {
  runnerControls = controls;
}

// get the discord client (used by discord.ts for sending messages)
export function getClient(): Client | null {
  return client;
}

// start the bot, register commands, listen for interactions
export async function startBot(): Promise<void> {
  const token = config.discordBotToken;
  const guildId = config.discordGuildId;

  // create the client
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // register slash commands
  await registerCommands(token, guildId);

  // set up command handler
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (error) {
      logger.error("Error handling discord command", error as Error);
      // try to reply with error
      const reply = { content: `❌ Error: ${(error as Error).message}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  });

  // log when ready
  client.once(Events.ClientReady, (c) => {
    logger.normal(`Discord bot logged in as ${c.user.tag}`);
  });

  // login
  await client.login(token);
}

// send a message to a discord channel by ID
export async function sendToChannel(channelId: string, content: string): Promise<void> {
  if (!client || !channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      // discord has a 2000 char limit per message
      if (content.length <= 2000) {
        await (channel as TextChannel).send(content);
      } else {
        // split long messages
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
    // /backtest <from> <to> [strategy]
    new SlashCommandBuilder()
      .setName("backtest")
      .setDescription("Run a historical backtest")
      .addStringOption((opt) => opt.setName("from").setDescription("Start date (YYYY-MM-DD)").setRequired(true))
      .addStringOption((opt) => opt.setName("to").setDescription("End date (YYYY-MM-DD)").setRequired(true))
      .addStringOption((opt) => opt.setName("strategy").setDescription("Strategy ID (optional)").setRequired(false)),

    // /strategies view|download|upload
    new SlashCommandBuilder()
      .setName("strategies")
      .setDescription("View, download, or upload strategies.json")
      .addStringOption((opt) =>
        opt.setName("action").setDescription("What to do").setRequired(true)
          .addChoices(
            { name: "view", value: "view" },
            { name: "download", value: "download" },
            { name: "upload", value: "upload" },
          ),
      )
      .addAttachmentOption((opt) => opt.setName("file").setDescription("JSON file to upload (for upload action)").setRequired(false)),

    // /restart
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the trading bot with fresh strategy config"),

    // /balance
    new SlashCommandBuilder()
      .setName("balance")
      .setDescription("Show P&L summary and trade history"),

    // /status
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show what the bot is currently doing"),

    // /help
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show all available commands and how to use them"),
  ];

  // register commands in the guild
  const rest = new REST({ version: "10" }).setToken(token);
  const clientId = Buffer.from(token.split(".")[0], "base64").toString();
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands.map((c) => c.toJSON()),
  });

  logger.normal(`Registered ${commands.length} slash commands in guild ${guildId}`);
}

// route a slash command to the right handler
async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case "backtest":
      await handleBacktest(interaction);
      break;
    case "strategies":
      await handleStrategies(interaction);
      break;
    case "restart":
      await handleRestart(interaction);
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

//=============================================================================
// COMMAND HANDLERS
//=============================================================================

// /backtest - run a historical backtest
async function handleBacktest(interaction: ChatInputCommandInteraction): Promise<void> {
  const fromDate = interaction.options.getString("from", true);
  const toDate = interaction.options.getString("to", true);
  const strategyId = interaction.options.getString("strategy") || undefined;

  // reply immediately (backtests take time)
  await interaction.reply(`🔄 Running backtest: ${fromDate} to ${toDate}${strategyId ? ` (${strategyId})` : ""}...`);

  try {
    // run the backtest
    const result = await runBacktestProgrammatic(fromDate, toDate, strategyId);

    // format results for discord
    const msg = formatBacktestResults(result);

    // edit the reply with results
    await interaction.editReply(msg);
  } catch (error) {
    await interaction.editReply(`❌ Backtest failed: ${(error as Error).message}`);
  }
}

// /strategies - view, download, or upload strategies.json
async function handleStrategies(interaction: ChatInputCommandInteraction): Promise<void> {
  const action = interaction.options.getString("action", true);
  const strategiesPath = path.join(process.cwd(), "strategies.json");

  if (action === "view") {
    // show strategies.json content in a code block
    if (!fs.existsSync(strategiesPath)) {
      await interaction.reply("❌ strategies.json not found");
      return;
    }
    const content = fs.readFileSync(strategiesPath, "utf8");
    // discord code block limit is ~2000 chars
    if (content.length > 1900) {
      await interaction.reply("📄 strategies.json is too large for a message. Use `/strategies download` instead.");
    } else {
      await interaction.reply("```json\n" + content + "\n```");
    }

  } else if (action === "download") {
    // send strategies.json as a file attachment
    if (!fs.existsSync(strategiesPath)) {
      await interaction.reply("❌ strategies.json not found");
      return;
    }
    const attachment = new AttachmentBuilder(strategiesPath, { name: "strategies.json" });
    await interaction.reply({ content: "📎 Current strategies.json:", files: [attachment] });

  } else if (action === "upload") {
    // user uploads a new strategies.json
    const file = interaction.options.getAttachment("file");
    if (!file) {
      await interaction.reply("❌ Please attach a JSON file with the upload action");
      return;
    }

    try {
      // fetch the file content
      const response = await fetch(file.url);
      const text = await response.text();

      // validate it's valid JSON with strategies array
      const parsed = JSON.parse(text);
      if (!parsed.strategies || !Array.isArray(parsed.strategies)) {
        await interaction.reply('❌ Invalid format: must have a "strategies" array');
        return;
      }

      // backup current file
      if (fs.existsSync(strategiesPath)) {
        const backup = strategiesPath + ".backup";
        fs.copyFileSync(strategiesPath, backup);
      }

      // save new file
      fs.writeFileSync(strategiesPath, JSON.stringify(parsed, null, 2));
      await interaction.reply(`✅ strategies.json updated (${parsed.strategies.length} strategies). Use \`/restart\` to apply.`);
    } catch (error) {
      await interaction.reply(`❌ Upload failed: ${(error as Error).message}`);
    }
  }
}

// /restart - restart the trading loop
async function handleRestart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!runnerControls) {
    await interaction.reply("❌ Runner not initialized");
    return;
  }

  await interaction.reply("🔄 Restarting trading bot...");

  try {
    // stop current runner
    runnerControls.stop();

    // small delay for cleanup
    await new Promise((r) => setTimeout(r, 1000));

    // start fresh
    runnerControls.start().catch((err) => {
      logger.error("Runner restart failed", err);
    });

    await interaction.editReply("✅ Trading bot restarted. Strategies reloaded from strategies.json.");
  } catch (error) {
    await interaction.editReply(`❌ Restart failed: ${(error as Error).message}`);
  }
}

// /balance - show P&L summary
async function handleBalance(interaction: ChatInputCommandInteraction): Promise<void> {
  // load all-time stats
  const stats = state.loadAllTimeStats();

  // get account balance
  const accountInfo = config.mode === "PAPER" ? paperBroker.getAccountInfo() : null;

  // format the message
  const allTime = stats.allTimeStats;
  const pnlSign = allTime.totalPnL >= 0 ? "+" : "";
  const winRate = allTime.totalTrades > 0 ? ((allTime.wins / allTime.totalTrades) * 100).toFixed(1) : "0.0";

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

  // per-symbol breakdown
  const symbolKeys = Object.keys(stats.symbolStats);
  if (symbolKeys.length > 0) {
    msg += `\n**PER-SYMBOL**\n`;
    msg += `──────────────────────────\n`;
    for (const sym of symbolKeys) {
      const s = stats.symbolStats[sym];
      const sPnlSign = s.totalPnL >= 0 ? "+" : "";
      const sWinRate = s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(0) : "0";
      msg += `${sym}: ${s.totalTrades} trades | ${sPnlSign}$${s.totalPnL.toFixed(2)} | ${sWinRate}% win\n`;
    }
  }

  await interaction.reply(msg);
}

// /status - show what bot is doing
async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  let msg = `🤖 **BOT STATUS**\n`;
  msg += `══════════════════════════\n`;
  msg += `**Mode:** ${config.mode}\n`;
  msg += `**Uptime:** Bot is running\n`;

  if (runnerControls) {
    msg += `**Trading:** ${runnerControls.getStatus()}\n`;
  } else {
    msg += `**Trading:** Not initialized\n`;
  }

  // show account info
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
async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const msg = `🤖 **SignalFlow Bot Commands**
══════════════════════════════

📊 **/backtest** \`from\` \`to\` \`[strategy]\`
Run a historical backtest on past market data.
Example: \`/backtest from:2026-03-01 to:2026-04-01\`

📄 **/strategies** \`action\`
Manage the strategies.json config file.
• \`view\` — show current config in chat
• \`download\` — get the file as an attachment
• \`upload\` — replace config (attach a .json file)

🔄 **/restart**
Stop the trading loop, reload strategies.json, and start fresh.
Use after uploading a new strategies.json.

💰 **/balance**
Show total P&L, win rate, per-symbol breakdown, and account balance.

🤖 **/status**
Show what the bot is doing right now (waiting, monitoring, positions, etc.)

❓ **/help**
This message.

══════════════════════════════
**How it works:**
The bot runs an automated trading strategy during market hours (9:30 AM - 4:00 PM EST).
It monitors symbols for Opening Range Breakouts with FVG confirmation.
All strategy parameters are in \`strategies.json\` — edit and \`/restart\` to apply.
`;

  await interaction.reply(msg);
}

//=============================================================================
// HELPERS
//=============================================================================

// format backtest results for discord
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

  // trade log (abbreviated)
  if (result.trades && result.trades.length > 0) {
    msg += `\n**TRADES:**\n`;
    for (const t of result.trades.slice(0, 20)) { // max 20 trades in message
      const tSign = t.pnl >= 0 ? "+" : "";
      msg += `${t.date} ${t.symbol} ${t.side} ${tSign}$${t.pnl.toFixed(2)} (${t.exitReason})\n`;
    }
    if (result.trades.length > 20) {
      msg += `... and ${result.trades.length - 20} more trades\n`;
    }
  }

  return msg;
}

// split a long message into chunks
function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // find last newline before limit
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1) splitAt = maxLength;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}
