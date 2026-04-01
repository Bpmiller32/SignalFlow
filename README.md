# SignalFlow

**Automated Opening Range Breakout Trading System with Fair Value Gap Confirmation**

A minimal, production-ready intraday trading bot built on the "stateless with a journal" philosophy.

## Quick Start

```bash
npm install
cp .env.example .env  # Add your Alpaca API keys
npx ts-node src/main.ts
```

## What It Does

- Captures opening range (9:30-9:35 AM EST)
- Detects breakouts with volume confirmation
- Confirms momentum using 3-candle Fair Value Gap pattern
- Executes trades with 2:1 risk/reward ratio
- Protects profits with partial exits + trailing stops
- Survives crashes via file-based state management

## Strategy

7 Steps:

1. Opening range definition (first 5-min candle)
2. Wait for breakout (above/below range)
3. FVG momentum confirmation (3-candle pattern)
4. Entry (market order)
5. Initial stop (below/above opening range)
6. Partial exit at 1R (50% position)
7. Trailing stop for remainder

## Stack

- TypeScript + Node.js
- Alpaca (real-time data + paper trading)
- Discord webhooks (notifications)
- JSON files (state persistence)

## Documentation

Everything you need is in `projectPlan.txt` - that's the journal.

## Philosophy

Simple. Clean. Minimal. Self-documenting code with no fancy abstractions.

---

_Built for conservative, consistent profits over frequent trading._

## **SignalFlow Trading Bot - Explained Like You're 5** 🎯

### **The Big Idea (One Sentence)**

"The app waits for the stock market to do something predictable, then makes a small bet with built-in safety limits."

---

## **The Story: How SignalFlow Works** 📖

### **1. WAKE UP & GET READY (9:30 AM)** ☀️

The app wakes up when the stock market opens (like school starting at 9:30 AM).

**What it does:**

- Checks: "Do I have money to trade today?" ✅
- Checks: "Are my Discord notifications working?" ✅
- Says: "Good morning! I'm watching SPY and QQQ today."

---

### **2. WATCH THE OPENING (9:30-9:35 AM)** 👀

For the first 5 minutes, the app just **watches** - like watching kids on a playground to see who's energetic and who's sleepy.

**It measures the "Opening Range":**

- **High Point**: The highest price in those 5 minutes (like the tallest jump)
- **Low Point**: The lowest price in those 5 minutes (like the lowest crouch)
- **Size**: How far apart high and low are (like measuring the playground)

**20 Filters Check If It's Worth Watching:**

**Filter 1-5: "Is this playground worth playing on?"**

- Too small? ❌ (range < 0.15%) - "This is boring, nothing's happening"
- Too big? ❌ (range > 1.5%) - "This is crazy, too wild to predict"
- Too gappy? ❌ (opened way higher/lower than yesterday) - "Something weird happened overnight"
- Weak setup? ❌ (strength score < 5/10) - "This doesn't look promising"

**If it passes:** "Okay, I'll keep watching this stock!" ✅

---

### **3. WAIT FOR A BREAKOUT (After 9:35 AM)** 🏃

Now the app watches 1-minute chunks (like watching every minute of a game).

**It's waiting for price to BREAK the opening range:**

- **Break ABOVE the high?** 📈 "Stock is trying to go UP!"
- **Break BELOW the low?** 📉 "Stock is trying to go DOWN!"

**Filter 6-9: "Is this breakout real?"**

- Enough volume? ❌ (needs 1.2x normal) - "Not enough people are playing"
- Actual volume? ❌ (needs 10,000+ per minute) - "Too quiet, not safe"
- Fresh data? ❌ (candle < 2 min old) - "Is this information stale?"
- Quick enough? ❌ (must happen within 5 min) - "Took too long, opportunity passed"

---

### **4. MOMENTUM CHECK - The "FVG Pattern" (3 Candles)** 🚀

When price breaks out, the app needs **proof it's real** by watching the next 3 minutes:

**Think of it like a running race:**

**Candle 1 (Breakout):** "Runner crosses the start line HARD!" 💨
**Candle 2 (Momentum):** "Runner is sprinting with strong legs!" 🏃‍♂️
**Candle 3 (Gap):** "Runner is pulling away from the pack!" 🎯

**Filter 10-15: "Is the runner really fast?"**

- Strong body? ❌ (body ≥ 55% of candle) - "Not sprinting, just jogging"
- Big move? ❌ (range ≥ 0.15%) - "Barely moving"
- Committed? ❌ (close in top/bottom 25%) - "Runner is slowing down"
- Volume spike? ❌ (1.5x normal) - "Not much excitement"
- Gap confirmed? ❌ (1.5% tolerance) - "Runner didn't pull away enough"

**If ALL 3 candles look good:** "THIS IS IT! Time to trade!" ✅

---

### **5. ENTER THE TRADE** 💰

The app says: "I'm going to bet that this continues!"

**Filter 16-20: "Can I actually do this trade?"**

- Signal quality? ❌ (weak signals get 50% size) - "I'm not super confident"
- Opening range strength? ❌ (weak gets 75% size) - "Setup wasn't perfect"
- Too small? ❌ (position < $100) - "Not worth the fees"
- Too big? ❌ (position > $10,000) - "Too risky for one trade"
- At least 1 share? ❌ - "Can't buy 0.3 shares"

**If it passes, the app:**

- **Buys** (if price broke UP) or **Sells Short** (if price broke DOWN)
- Spends about $1,000 per trade
- Sends you a Discord message: "🟢 I just bought SPY at $502.50!"

---

### **6. SET SAFETY LIMITS** 🛡️

The app immediately sets **2 automatic exit points:**

**Stop Loss (Emergency Exit):** 📉
"If price goes AGAINST me and hits this level, GET OUT to prevent big losses!"

- Set just below/above the opening range
- Think: "If we're wrong, lose a little ($10-30)"

**Take Profit (Victory Exit):** 📈
"If price goes WITH me and hits this level, TAKE THE WIN!"

- Set at 2x the stop distance
- Think: "If we're right, win double ($20-60)"

**This is called "2:1 Risk/Reward":**

- Risk $1 to make $2
- Win half the time = still profitable

---

### **7. WATCH & WAIT** ⏰

The app checks every 10 seconds: "Did we hit stop or target yet?"

**3 things can happen:**

1. **Hit Target (WIN)** 🎉: "We won! +$45 profit!"
2. **Hit Stop (LOSS)** 😔: "We lost. -$20 loss."
3. **End of Day** 🌙: "Market's closing, exit now at current price."

**Either way, only 1 trade per stock per day.**

---

### **8. GO TO SLEEP (4:00 PM)** 😴

Market closes. The app:

- Closes any open positions
- Sends a summary to Discord: "Today: 1 trade, 1 win, +$45"
- Saves everything to files
- Goes to sleep

Tomorrow, it starts over!

---

## **What's ATR? (The Confusing Part)** 📊

**ATR = "Average True Range"**

**Simple version:** "How much does this stock usually wiggle in a minute?"

**Example:**

- SPY normally moves ±$0.50 per minute (its ATR)
- So instead of using the opening range for stops...
- We could say: "Stop if it moves $0.75 against us" (1.5 × ATR)

**Why use it?**

- Some stocks are calm (AAPL moves ±$0.20)
- Some stocks are wild (TSLA moves ±$2.00)
- ATR adjusts stops based on the stock's personality

**Your app mostly doesn't use ATR** because:

- ATR needs 15 minutes of data (~9:50 AM)
- Most trades happen earlier (9:40-10:00 AM)
- So it uses Opening Range stops instead (simpler!)

---

## **The 20 Filters (Simplified Checklist)** ✅

**Phase 1 - Pre-Market (1 filter):**

1. ❌ Skip if earnings today (too unpredictable)

**Phase 2 - Opening Range (4 filters):** 2. ❌ Gap too big (>1.0%) 3. ❌ Range too small (<0.15%) 4. ❌ Range too big (>1.5%) 5. ❌ Weak setup (strength <5/10)

**Phase 3 - Breakout (4 filters):** 6. ❌ Low breakout volume (<1.2x) 7. ❌ Too quiet overall (<10k volume/min) 8. ❌ Stale data (>2 min old) 9. ❌ Took too long (>5 min to complete)

**Phase 4 - FVG Pattern (6 filters):** 10. ❌ Wrong direction 11. ❌ Body too small (<55%) 12. ❌ Range too small (<0.15%) 13. ❌ Close not committed (<25%) 14. ❌ Volume too low (<1.5x) 15. ❌ No gap between candles

**Phase 5 - Execution (5 filters):** 16. ❌ Weak signal (reduce size) 17. ❌ Weak opening (reduce size) 18. ❌ Too small (<$100) 19. ❌ Too big (>$10,000) 20. ❌ Can't buy partial shares

---

## **Why So Many Filters?** 🤔

**Think of it like crossing the street:**

- Look left ✅
- Look right ✅
- Check for bikes ✅
- Wait for green light ✅
- Hold an adult's hand ✅

**Each filter = one safety check.**

Most days, the app will say: "No good opportunities today" and do NOTHING.

**That's a feature, not a bug.**

Better to skip 100 bad trades than take 1 terrible trade.

---

## **The Philosophy** 🧘

Your app is **conservative and patient**:

- It waits for crystal-clear setups
- It only trades when multiple things line up
- It accepts "no trade" days
- It never forces a trade just to trade

**Result:** When it DOES trade, it has high confidence the setup is real.

---

Does this help? Any part you want me to explain more simply?
