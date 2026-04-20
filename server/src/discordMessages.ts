// discordMessages.ts - Discord message formatting and sending
// All notification messages are formatted here and sent via the Discord bot.
// All messages go to the single configured channel (DISCORD_CHANNEL_ID).

import config from "./config";
import { sendToChannel } from "./discordBot";
import { formatEstTime } from "./timeUtils";

// send a formatted message to the bot's notification channel
async function send(content: string): Promise<void> {
  if (!config.discordChannelId) return; // no channel configured, skip silently
  await sendToChannel(config.discordChannelId, content);
}

// ---- TRADE NOTIFICATIONS ----

// send trade entry notification
export async function sendTradeEntry(
  symbol: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  quantity: number,
  stopPrice: number,
  targetPrice: number,
  risk: number,
  reward: number,
): Promise<void> {
  const emoji = side === "LONG" ? "🟢" : "🔴";
  const dollarValue = entryPrice * quantity;
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const rrRatio = rewardPerShare / riskPerShare;

  const message = `${emoji} **${side} ENTRY - ${symbol}**
──────────────────────────
**Entry:**   $${entryPrice.toFixed(2)} × ${quantity} shares = $${dollarValue.toFixed(2)}
**Stop:**    $${stopPrice.toFixed(2)} (-$${riskPerShare.toFixed(2)}/share)
**Target:**  $${targetPrice.toFixed(2)} (+$${rewardPerShare.toFixed(2)}/share)
──────────────────────────
**Risk:**    $${risk.toFixed(2)} | **Reward:** $${reward.toFixed(2)}
**R/R:**     ${rrRatio.toFixed(1)}:1
──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await send(message);
}

// send trade exit notification
export async function sendTradeExit(
  symbol: string,
  exitPrice: number,
  pnl: number,
  pnlPercent: number,
  reason: string,
  duration: string,
): Promise<void> {
  const emoji = pnl >= 0 ? "🎯" : "🛑";
  const pnlFormatted = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const pnlPercentFormatted = pnl >= 0 ? `+${pnlPercent.toFixed(2)}%` : `-${Math.abs(pnlPercent).toFixed(2)}%`;

  const message = `${emoji} **EXIT - ${reason.toUpperCase()} - ${symbol}**
──────────────────────────
**Exit:**     $${exitPrice.toFixed(2)}
**P&L:**      ${pnlFormatted} (${pnlPercentFormatted})
**Duration:** ${duration}
──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await send(message);
}

// send daily summary notification
export async function sendDailySummary(
  date: string,
  symbols: string[],
  totalTrades: number,
  wins: number,
  losses: number,
  totalPnL: number,
  accountBalance: number,
  bestTradePnL: number | null,
  worstTradePnL: number | null,
  currentStreak: { type: "win" | "loss" | "none"; count: number },
): Promise<void> {
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
  const pnlFormatted = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;
  const emoji = totalPnL >= 0 ? "💰" : "📉";

  let streakText = "➖ No streak";
  if (currentStreak.type === "win" && currentStreak.count > 0) {
    streakText = `🔥 ${currentStreak.count} win${currentStreak.count > 1 ? "s" : ""} in a row`;
  } else if (currentStreak.type === "loss" && currentStreak.count > 0) {
    streakText = `❄️ ${currentStreak.count} loss${currentStreak.count > 1 ? "es" : ""} in a row`;
  }

  const bestText = bestTradePnL !== null ? `+$${bestTradePnL.toFixed(2)}` : "N/A";
  const worstText = worstTradePnL !== null ? `-$${Math.abs(worstTradePnL).toFixed(2)}` : "N/A";

  const message = `🌙 **DAILY SUMMARY - ${date}**
══════════════════════════
**Symbols:** ${symbols.join(", ")}
**Trades:**  ${totalTrades} (${wins}W / ${losses}L)
**Win Rate:** ${winRate}%
**Streak:**  ${streakText}
══════════════════════════
${emoji} **Daily P&L:** ${pnlFormatted}
💼 **Balance:** $${accountBalance.toFixed(2)}
══════════════════════════
**Best:** ${bestText} | **Worst:** ${worstText}`;

  await send(message);
}

// ---- SYSTEM NOTIFICATIONS ----

// send app startup notification
export async function sendStartup(mode: string, symbols: string[]): Promise<void> {
  const message = `🚀 **SignalFlow Started**
**Mode:** ${mode}
**Symbols:** ${symbols.join(", ")}
**Time:** ${formatEstTime(new Date())} EST`;

  await send(message);
}

// send app shutdown notification
export async function sendShutdown(reason: string): Promise<void> {
  const message = `🌙 **SignalFlow Shutdown**
**Reason:** ${reason}
**Time:** ${formatEstTime(new Date())} EST`;

  await send(message);
}

// send opening range notification
export async function sendOpeningRange(symbol: string, high: number, low: number, sizePercent: number): Promise<void> {
  const message = `📊 **OPENING RANGE - ${symbol}**
**High:** $${high.toFixed(2)} | **Low:** $${low.toFixed(2)} | **Size:** ${sizePercent.toFixed(2)}%
✅ Monitoring for breakout...`;

  await send(message);
}

// send opening range skipped notification
export async function sendOpeningRangeSkipped(symbol: string, reason: string): Promise<void> {
  const message = `⚠️ **SKIPPING - ${symbol}**
**Reason:** ${reason}`;

  await send(message);
}

// send monitoring update
export async function sendMonitoringUpdate(symbol: string, currentPrice: number, rangeHigh: number, rangeLow: number, tradesToday: number): Promise<void> {
  const message = `👀 **${symbol}** $${currentPrice.toFixed(2)} | OR: $${rangeLow.toFixed(2)}-$${rangeHigh.toFixed(2)} | Trades: ${tradesToday}`;
  await send(message);
}

// send market status notification
export async function sendMarketStatus(status: string): Promise<void> {
  await send(`🕐 ${status}`);
}

// send market open summary
export async function sendMarketOpenSummary(date: string, symbolCount: number, symbols: string[], maxTradesPerDay: number, cutoffTime: string): Promise<void> {
  const message = `🌅 **MARKET OPEN - ${date}**
**Monitoring:** ${symbolCount} symbols (${symbols.join(", ")})
**Limit:** ${maxTradesPerDay}/symbol | **Cutoff:** ${cutoffTime} EST`;

  await send(message);
}

// ---- ERROR NOTIFICATIONS ----

// send error notification
export async function sendError(errorMessage: string, details?: string): Promise<void> {
  let message = `🚨 **ERROR:** ${errorMessage}`;
  if (details) message += `\n${details}`;
  await send(message);
}

// send API failure notification
export async function sendApiFailure(service: string, error: string): Promise<void> {
  await send(`🚨 **API FAILURE** ${service}: ${error}`);
}

// send order rejection notification
export async function sendOrderRejection(symbol: string, side: string, reason: string): Promise<void> {
  await send(`🚨 **ORDER REJECTED** ${symbol} ${side}: ${reason}`);
}

// send position sync issue notification
export async function sendPositionSyncIssue(symbol: string, issue: string): Promise<void> {
  await send(`⚠️ **SYNC ISSUE** ${symbol}: ${issue}`);
}
