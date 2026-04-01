//==============================================================================
// BACKTEST-TODAY.TS - DAILY BACKTEST ANALYSIS
//==============================================================================
// This script analyzes what would have happened if the strategy had traded today.
// Run this at end of day to see if opening ranges were valid and if breakouts
// would have been profitable.
//
// Usage: npx ts-node backtest-today.ts
//
// Output:
// - Which symbols had valid opening ranges
// - Which symbols had breakouts (with volume confirmation)
// - Simulated P&L for each breakout
// - Summary statistics
//==============================================================================

import config from "./src/config";
import * as alpacaData from "./src/alpacaData";
import * as strategy from "./src/strategy";
import * as timeUtils from "./src/timeUtils";

//==============================================================================
// BACKTEST LOGIC
//==============================================================================

async function backtestToday() {
  console.log("═".repeat(80));
  console.log("DAILY BACKTEST - What-If Analysis");
  console.log("═".repeat(80));
  console.log(`Date: ${timeUtils.getTodayDateString()}`);
  console.log(`Symbols: ${config.symbols.join(", ")}`);
  console.log("");
  console.log("This shows if the strategy COULD have traded today (simplified):");
  console.log("  1. Did opening range qualify? (first 5 min of trading)");
  console.log("  2. Did price break the range with volume?");
  console.log("  3. Would that trade have been profitable?");
  console.log("═".repeat(80));
  console.log("");

  const today = timeUtils.getTodayDateString();
  let totalSymbols = 0;
  let passedOpeningRange = 0;
  let hadBreakouts = 0;
  let wouldHaveTraded = 0;

  for (const symbol of config.symbols) {
    totalSymbols++;
    console.log(`\n${"─".repeat(80)}`);
    console.log(`${symbol}`);
    console.log("─".repeat(80));

    try {
      // Step 1: Get opening range and validate
      const candles5min = await alpacaData.fetch5MinCandles(symbol, today);
      if (candles5min.length === 0) {
        console.log(`❌ No data available`);
        continue;
      }

      const openingCandle = candles5min[0];
      const openingRange = strategy.calculateOpeningRange(openingCandle);
      const openingRangeAvgVol = strategy.calculateOpeningRangeAvgVolume(openingCandle);

      // Get previous close for gap check
      let prevClose: number | undefined;
      try {
        const dailyCandles = await alpacaData.fetchDailyCandles(symbol, 2);
        if (dailyCandles.length >= 1) {
          prevClose = dailyCandles[dailyCandles.length - 1].close;
        }
      } catch (e) {
        // Ignore if can't get previous close
      }

      // Check all opening range filters
      let gapPassed = true;
      let gapPercent = 0;
      if (prevClose) {
        gapPercent = strategy.calculatePreMarketGap(openingCandle, prevClose);
        gapPassed = !strategy.isPreMarketGapTooLarge(gapPercent, config.maxPremarketGapPercent);
      }

      const sizeValid = strategy.isOpeningRangeValid(openingRange, openingCandle.close, config);
      const orStrength = strategy.scoreOpeningRangeStrength(openingRange, openingCandle, config);
      const strengthPassed = orStrength >= config.openingRangeMinStrength;

      console.log(`Opening Range: $${openingRange.high.toFixed(2)} - $${openingRange.low.toFixed(2)} (${openingRange.size.toFixed(2)}%)`);
      console.log(`  (Opening Range = high and low of first 5 minutes, 9:30-9:35 AM)`);
      console.log(`  Gap: ${prevClose ? `${gapPercent >= 0 ? "+" : ""}${gapPercent.toFixed(2)}%` : "N/A"} ${gapPassed ? "✅" : "❌"} (pre-market gap from yesterday's close)`);
      console.log(`  Size: ${openingRange.size.toFixed(2)}% ${sizeValid ? "✅" : "❌"} (range as % of stock price - not too tight/wide)`);
      console.log(`  Strength: ${orStrength.toFixed(1)}/10 ${strengthPassed ? "✅" : "❌"} (quality score - directional bias + volume + body)`);

      if (!gapPassed || !sizeValid || !strengthPassed) {
        console.log(`\n❌ REJECTED - Opening range failed filters`);
        continue;
      }

      passedOpeningRange++;
      console.log(`\n✅ PASSED opening range filters - Monitoring for breakout...`);

      // Step 2: Look for breakout with volume confirmation
      const candles1min = await alpacaData.fetch1MinCandles(symbol, today);
      
      let breakoutFound = false;
      let breakoutCandle: any = null;
      
      for (const candle of candles1min) {
        const breakout = strategy.detectBreakout(candle, openingRange, openingRangeAvgVol);
        
        if (breakout.detected) {
          breakoutFound = true;
          breakoutCandle = candle;
          hadBreakouts++;
          
          console.log(`\n✅ BREAKOUT: ${breakout.direction} at ${candle.timestamp.toLocaleString("en-US", { timeZone: "America/New_York" })}`);
          console.log(`  Price: $${candle.close.toFixed(2)}`);
          console.log(`  Volume: ${candle.volume.toLocaleString()} (${(candle.volume / openingRangeAvgVol).toFixed(1)}x)`);
          
          // Simulate trade outcome
          if (breakout.direction === "ABOVE") {
            const entryPrice = openingRange.high;
            const stopPrice = openingRange.low * (1 - config.stopLossBufferPercent / 100);
            const riskPerShare = entryPrice - stopPrice;
            const targetPrice = entryPrice + (riskPerShare * config.riskRewardRatio);
            
            console.log(`\n  📊 LONG Trade:`);
            console.log(`    Entry: $${entryPrice.toFixed(2)}`);
            console.log(`    Stop: $${stopPrice.toFixed(2)} (risk: $${riskPerShare.toFixed(2)}/share)`);
            console.log(`    Target: $${targetPrice.toFixed(2)} (reward: $${(riskPerShare * 2).toFixed(2)}/share)`);
            
            // Check outcome
            const highOfDay = Math.max(...candles1min.map(c => c.high));
            const lowOfDay = Math.min(...candles1min.map(c => c.low));
            
            if (lowOfDay <= stopPrice) {
              console.log(`\n  🛑 STOPPED OUT at $${stopPrice.toFixed(2)}`);
              console.log(`    Loss: -$${riskPerShare.toFixed(2)} per share`);
            } else if (highOfDay >= targetPrice) {
              wouldHaveTraded++;
              console.log(`\n  🎯 TARGET HIT at $${targetPrice.toFixed(2)}`);
              console.log(`    Profit: +$${(riskPerShare * 2).toFixed(2)} per share (2:1 R/R)`);
            } else {
              const currentCandle = candles1min[candles1min.length - 1];
              const unrealized = currentCandle.close - entryPrice;
              console.log(`\n  ⏳ STILL OPEN at $${currentCandle.close.toFixed(2)}`);
              console.log(`    Unrealized: ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)} per share`);
            }
          } else {
            // SHORT trade
            const entryPrice = openingRange.low;
            const stopPrice = openingRange.high * (1 + config.stopLossBufferPercent / 100);
            const riskPerShare = stopPrice - entryPrice;
            const targetPrice = entryPrice - (riskPerShare * config.riskRewardRatio);
            
            console.log(`\n  📊 SHORT Trade:`);
            console.log(`    Entry: $${entryPrice.toFixed(2)}`);
            console.log(`    Stop: $${stopPrice.toFixed(2)} (risk: $${riskPerShare.toFixed(2)}/share)`);
            console.log(`    Target: $${targetPrice.toFixed(2)} (reward: $${(riskPerShare * 2).toFixed(2)}/share)`);
            
            const highOfDay = Math.max(...candles1min.map(c => c.high));
            const lowOfDay = Math.min(...candles1min.map(c => c.low));
            
            if (highOfDay >= stopPrice) {
              console.log(`\n  🛑 STOPPED OUT at $${stopPrice.toFixed(2)}`);
              console.log(`    Loss: -$${riskPerShare.toFixed(2)} per share`);
            } else if (lowOfDay <= targetPrice) {
              wouldHaveTraded++;
              console.log(`\n  🎯 TARGET HIT at $${targetPrice.toFixed(2)}`);
              console.log(`    Profit: +$${(riskPerShare * 2).toFixed(2)} per share (2:1 R/R)`);
            } else {
              const currentCandle = candles1min[candles1min.length - 1];
              const unrealized = entryPrice - currentCandle.close;
              console.log(`\n  ⏳ STILL OPEN at $${currentCandle.close.toFixed(2)}`);
              console.log(`    Unrealized: ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)} per share`);
            }
          }
          
          break; // Only check first valid breakout per symbol
        }
      }

      if (!breakoutFound) {
        console.log(`\n❌ NO BREAKOUT with sufficient volume`);
        console.log(`  (Range was tested but volume requirements not met)`);
      }
    } catch (error) {
      console.log(`❌ Error: ${(error as Error).message}`);
    }
  }

  // Summary
  console.log(`\n${"═".repeat(80)}`);
  console.log("SUMMARY");
  console.log("═".repeat(80));
  console.log(`Total Symbols: ${totalSymbols}`);
  console.log(`Passed Opening Range: ${passedOpeningRange}/${totalSymbols}`);
  console.log(`Had Valid Breakouts: ${hadBreakouts}/${passedOpeningRange}`);
  console.log(`Would Have Traded: ${wouldHaveTraded} (if targets hit)`);
  console.log("═".repeat(80));
  console.log("");
  console.log("WHAT THIS MEANS:");
  console.log("════════════════");
  console.log("• Opening Range = High/low of first 5 minutes (9:30-9:35 AM)");
  console.log("• Gap = How much stock opened vs yesterday's close");
  console.log("• Size = Range as % of stock price (need 0.15-1.5%)");
  console.log("• Strength = Quality score based on volume, direction, body");
  console.log("• Breakout = Price broke above/below range WITH volume");
  console.log("• Volume = Need 1.2x opening range average (confirms strength)");
  console.log("• Stop = Auto-exit if price goes against us (limits loss)");
  console.log("• Target = Auto-exit if price hits 2x our risk (locks profit)");
  console.log("• 2:1 R/R = Risk $1 to make $2 (conservative)");
  console.log("");
  console.log("NOTE: This is a BEST CASE analysis that skips:");
  console.log("  - FVG pattern (3-candle momentum confirmation)");
  console.log("  - FVG gap requirements (candle 3 must gap from candle 1)");
  console.log("  - Signal quality grading (strong vs weak setups)");
  console.log("  - Partial exits + trailing stops (profit protection)");
  console.log("");
  console.log("Real trades have 20 filters total. This uses only 7 filters.");
  console.log("If this shows winners, real strategy might still reject them.");
  console.log("═".repeat(80));
}

backtestToday().then(() => process.exit(0)).catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
