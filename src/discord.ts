//==============================================================================
// DISCORD.TS - DISCORD WEBHOOK NOTIFICATIONS
//==============================================================================
// This file handles sending notifications to Discord via webhooks.
// Three separate channels: trades, system status, and errors.
// Messages are formatted for readability and include relevant details.
//==============================================================================

import axios from "axios";
import config from "./config";
import * as logger from "./logger";
import { formatEstTime } from "./timeUtils";

//==============================================================================
// WEBHOOK SENDING
//==============================================================================

// Send a message to a Discord webhook
async function sendWebhook(webhookUrl: string, content: string): Promise<void> {
  try {
    await axios.post(webhookUrl, {
      content,
      username: "FVG Bot",
    });
  } catch (error) {
    // If Discord webhook fails, log it but don't crash the app
    logger.error("Failed to send Discord notification", error as Error);
  }
}

//==============================================================================
// TRADE NOTIFICATIONS
//==============================================================================

// Send trade entry notification
// webhookUrl: optional override, falls back to global config
export async function sendTradeEntry(
  symbol: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  quantity: number,
  stopPrice: number,
  targetPrice: number,
  risk: number,
  reward: number,
  webhookUrl?: string,
): Promise<void> {
  const emoji = side === "LONG" ? "🟢" : "🔴";
  const dollarValue = entryPrice * quantity;
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const rrRatio = rewardPerShare / riskPerShare;

  const message = `${emoji} **${side} ENTRY - ${symbol}**
──────────────────────────
**Entry:**   $${entryPrice.toFixed(2)} × ${quantity} shares = $${dollarValue.toFixed(2)}
**Stop:**    $${stopPrice.toFixed(2)} (${riskPerShare >= 0 ? "-" : "+"}$${Math.abs(riskPerShare).toFixed(2)}/share)
**Target:**  $${targetPrice.toFixed(2)} (${rewardPerShare >= 0 ? "+" : "-"}$${Math.abs(rewardPerShare).toFixed(2)}/share)
──────────────────────────
**Risk:**    $${risk.toFixed(2)} *(if stop hit = max loss)*
**Reward:**  $${reward.toFixed(2)} *(if target hit = profit)*
**R/R:**     ${rrRatio.toFixed(1)}:1 *(risk $1 to make $${rrRatio.toFixed(1)})*
──────────────────────────
ℹ️ *Opening Range Breakout + FVG momentum confirmed*
ℹ️ *Will partial exit 50% at +1R, trail remainder*
──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookTrades, message);
}

// Send trade exit notification
// webhookUrl: optional override, falls back to global config
export async function sendTradeExit(
  symbol: string,
  exitPrice: number,
  pnl: number,
  pnlPercent: number,
  reason: string,
  duration: string,
  webhookUrl?: string,
): Promise<void> {
  const emoji = pnl >= 0 ? "🎯" : "🛑";
  const pnlFormatted =
    pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const pnlPercentFormatted =
    pnl >= 0
      ? `+${pnlPercent.toFixed(2)}%`
      : `-${Math.abs(pnlPercent).toFixed(2)}%`;

  const message = `${emoji} **EXIT - ${reason.toUpperCase()} - ${symbol}**
──────────────────────────
**Exit:**     $${exitPrice.toFixed(2)}
**P&L:**      ${pnlFormatted} (${pnlPercentFormatted})
**Duration:** ${duration}
──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookTrades, message);
}

// Send daily summary notification
// webhookUrl: optional override, falls back to global config
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
  webhookUrl?: string,
): Promise<void> {
  const winRate =
    totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
  const pnlFormatted =
    totalPnL >= 0
      ? `+$${totalPnL.toFixed(2)}`
      : `-$${Math.abs(totalPnL).toFixed(2)}`;
  const emoji = totalPnL >= 0 ? "💰" : "📉";

  // Format streak with emoji
  let streakText = "➖ No streak";
  if (currentStreak.type === "win" && currentStreak.count > 0) {
    streakText = `🔥 ${currentStreak.count} win${currentStreak.count > 1 ? "s" : ""} in a row`;
  } else if (currentStreak.type === "loss" && currentStreak.count > 0) {
    streakText = `❄️ ${currentStreak.count} loss${currentStreak.count > 1 ? "es" : ""} in a row`;
  }

  // Format best/worst trades
  const bestTradeText =
    bestTradePnL !== null ? `+$${bestTradePnL.toFixed(2)}` : "N/A";
  const worstTradeText =
    worstTradePnL !== null ? `-$${Math.abs(worstTradePnL).toFixed(2)}` : "N/A";

  const message = `🌙 **DAILY SUMMARY - ${date}**
══════════════════════════════════════
**Symbols:** ${symbols.join(", ")}
**Trades:**  ${totalTrades} (${wins}W / ${losses}L)
**Win Rate:** ${winRate}%
**Streak:**  ${streakText}
══════════════════════════════════════
${emoji} **Daily P&L:** ${pnlFormatted}
💼 **Account Balance:** $${accountBalance.toFixed(2)}
══════════════════════════════════════
**Best Trade:**  ${bestTradeText}
**Worst Trade:** ${worstTradeText}
══════════════════════════════════════`;

  await sendWebhook(webhookUrl || config.discordWebhookTrades, message);
}

//==============================================================================
// SYSTEM NOTIFICATIONS
//==============================================================================

// Send app startup notification
// webhookUrl: optional override, falls back to global config
export async function sendStartup(
  mode: string,
  symbols: string[],
  webhookUrl?: string,
): Promise<void> {
  const message = `🚀 **SignalFlow Started**
**Mode:** ${mode}
**Symbols:** ${symbols.join(", ")}
**Time:** ${formatEstTime(new Date())} EST
**Status:** Initializing...`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

// Send app shutdown notification
// webhookUrl: optional override, falls back to global config
export async function sendShutdown(reason: string, webhookUrl?: string): Promise<void> {
  const message = `🌙 **SignalFlow Shutdown**
**Reason:** ${reason}
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

// Send opening range calculated notification
// webhookUrl: optional override, falls back to global config
export async function sendOpeningRange(
  symbol: string,
  high: number,
  low: number,
  sizePercent: number,
  webhookUrl?: string,
): Promise<void> {
  const sizeInDollars = high - low;

  const message = `📊 **OPENING RANGE SET - ${symbol}**
──────────────────────────
**High:** $${high.toFixed(2)}
**Low:**  $${low.toFixed(2)}
**Size:** $${sizeInDollars.toFixed(2)} (${sizePercent.toFixed(2)}%)
──────────────────────────
ℹ️ *Opening Range = First 5 minutes of trading (9:30-9:35 AM)*
ℹ️ *We trade when price breaks above HIGH or below LOW with volume*
──────────────────────────
✅ Range qualifies for trading
🔍 Monitoring for breakout...`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

// Send opening range skipped notification
// webhookUrl: optional override, falls back to global config
export async function sendOpeningRangeSkipped(
  symbol: string,
  reason: string,
  webhookUrl?: string,
): Promise<void> {
  // Add explanation based on rejection type
  let explanation = "";
  if (reason.includes("gap")) {
    explanation = "\nℹ️ *Large gaps often fill intraday = false breakouts*";
  } else if (reason.includes("tight") || reason.includes("0.")) {
    explanation = "\nℹ️ *Tight range = choppy/noisy price action = low quality*";
  } else if (reason.includes("wide") || reason.includes("volatile")) {
    explanation = "\nℹ️ *Wide range = too volatile = unpredictable movement*";
  } else if (reason.includes("strength") || reason.includes("weak")) {
    explanation = "\nℹ️ *Low strength score = poor setup quality = low win probability*";
  } else if (reason.includes("Earnings")) {
    explanation = "\nℹ️ *Earnings create unpredictable volatility = avoid*";
  }

  const message = `⚠️ **SKIPPING TODAY - ${symbol}**
**Reason:** ${reason}${explanation}
**Status:** No trades will be taken today for ${symbol}`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

// Send monitoring status update
// webhookUrl: optional override, falls back to global config
export async function sendMonitoringUpdate(
  symbol: string,
  currentPrice: number,
  rangeHigh: number,
  rangeLow: number,
  tradesToday: number,
  webhookUrl?: string,
): Promise<void> {
  const distanceToHigh = rangeHigh - currentPrice;
  const distanceToLow = currentPrice - rangeLow;

  const message = `👀 **MONITORING - ${symbol}**
──────────────────────────
**Current:** $${currentPrice.toFixed(2)}
**OR High:** $${rangeHigh.toFixed(2)} (need +$${distanceToHigh.toFixed(2)})
**OR Low:**  $${rangeLow.toFixed(2)} (need -$${distanceToLow.toFixed(2)})
──────────────────────────
**Trades Today:** ${tradesToday}
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

// Send market status notification
// webhookUrl: optional override, falls back to global config
export async function sendMarketStatus(status: string, webhookUrl?: string): Promise<void> {
  const message = `🕐 **MARKET STATUS**
${status}`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

// Send market open summary (mobile-friendly overview)
// webhookUrl: optional override, falls back to global config
export async function sendMarketOpenSummary(
  date: string,
  symbolCount: number,
  symbols: string[],
  maxTradesPerDay: number,
  cutoffTime: string,
  webhookUrl?: string,
): Promise<void> {
  const message = `🌅 **MARKET OPEN - ${date}**
═══════════════════════
**Monitoring:** ${symbolCount} symbols (${symbols.join(", ")})
**Opening Range:** Will capture at 9:35 AM EST
**Trade Limit:** ${maxTradesPerDay} per symbol
**Cutoff Time:** ${cutoffTime} EST
═══════════════════════
📊 Waiting for opening range...`;

  await sendWebhook(webhookUrl || config.discordWebhookSystem, message);
}

//==============================================================================
// ERROR NOTIFICATIONS
//==============================================================================

// Send error notification
// webhookUrl: optional override, falls back to global config
export async function sendError(
  errorMessage: string,
  details?: string,
  webhookUrl?: string,
): Promise<void> {
  let message = `🚨 **ERROR**
──────────────────────────
${errorMessage}`;

  if (details) {
    message += `\n\n**Details:**\n${details}`;
  }

  message += `\n──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookErrors, message);
}

// Send API failure notification
// webhookUrl: optional override, falls back to global config
export async function sendApiFailure(
  service: string,
  error: string,
  webhookUrl?: string,
): Promise<void> {
  const message = `🚨 **API FAILURE**
──────────────────────────
**Service:** ${service}
**Error:** ${error}
──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookErrors, message);
}

// Send order rejection notification
// webhookUrl: optional override, falls back to global config
export async function sendOrderRejection(
  symbol: string,
  side: string,
  reason: string,
  webhookUrl?: string,
): Promise<void> {
  const message = `🚨 **ORDER REJECTED**
──────────────────────────
**Symbol:** ${symbol}
**Side:** ${side}
**Reason:** ${reason}
──────────────────────────
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookErrors, message);
}

// Send position sync issue notification
// webhookUrl: optional override, falls back to global config
export async function sendPositionSyncIssue(
  symbol: string,
  issue: string,
  webhookUrl?: string,
): Promise<void> {
  const message = `⚠️ **POSITION SYNC ISSUE**
──────────────────────────
**Symbol:** ${symbol}
**Issue:** ${issue}
──────────────────────────
**Action:** Syncing with broker...
**Time:** ${formatEstTime(new Date())} EST`;

  await sendWebhook(webhookUrl || config.discordWebhookErrors, message);
}
