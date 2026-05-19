# Phoenix Zero × Tenderly — L2 Circuit Breaker

**Automatic protocol pause triggered 27 seconds before sequencer congestion.**

Replaces OpenZeppelin Defender emergency pause automation.  
Works with any `Pausable` contract on Base, Arbitrum, Optimism, or zkSync.

---

## What it does

Every 30 seconds, this Tenderly Web3 Action:
1. Calls Phoenix Zero `/api/v1/safe` (pays $0.0001 USDC via x402)
2. If `safe: false` → calls `pause()` on your contract automatically
3. If Phoenix Zero is unreachable → **does nothing** (fail-open, your protocol stays live)

---

## Why this matters: May 17, 2026 Incident

| Time (UTC)   | Standard tools | Phoenix Zero |
|--------------|----------------|--------------|
| 23:29:43     | mempool: normal | **RTT spike detected** |
| 23:29:48     | —              | **Action calls `pause()`** |
| 23:30:10     | revert ratio 50%+ | protocol already paused |
| 23:39:35     | revert ratio 61.4% | funds SAFU |

**27-second lead time.** Chainlink L2 Sequencer Feed only tells you the sequencer is down — *after* it's already down. Phoenix Zero detects degradation in real-time.

---

## Setup (5 minutes)

### 1. Add Tenderly Secrets

In your Tenderly dashboard → Project → Secrets:

| Secret key | Value |
|------------|-------|
| `RPC_URL` | Your chain RPC (e.g. Base mainnet) |
| `RELAYER_PRIVATE_KEY` | Key that calls `pause()` on your contract |
| `PHOENIX_PAYMENT_KEY` | Separate key with ~$1 USDC on Base (for micropayments) |
| `PAUSABLE_CONTRACT_ADDRESS` | Your contract address |
| `ALERT_WEBHOOK_URL` | Slack/Telegram webhook for alerts |

> **Security note:** `PHOENIX_PAYMENT_KEY` is intentionally separate from `RELAYER_PRIVATE_KEY`.  
> It only holds micropayment funds ($0.0001/call = ~$4.32/month at 1 call/min).  
> Principle of least privilege: the payment key never touches your contract.

### 2. Deploy the Action

```bash
npm install
npx tenderly actions deploy
```

### 3. Done

The action runs every 30 seconds. Monitor alerts via your webhook.

---

## Fail-Safe Architecture

```
Phoenix Zero UP   → check safe flag → if false: pause()
Phoenix Zero DOWN → send alert only → protocol continues normally
```

Your protocol **cannot be frozen by Phoenix Zero failure.** If our endpoint is unreachable,
the action catches the error and does nothing. You receive an alert to investigate manually.

---

## Pricing

- Phoenix Zero API: **$0.0001 USDC per call** (x402, automatic)
- At 30s intervals: ~2,880 calls/day = **$0.29/day**
- During MEV storm (surge pricing): $0.001/call — but you want accurate data exactly then

---

## Chainlink vs Phoenix Zero

| | Chainlink L2 Feed | Phoenix Zero |
|---|---|---|
| Signal type | Binary (UP/DOWN) | Latency + MEV risk score |
| Updates when | Sequencer already down | **27s before congestion** |
| MEV detection | ❌ | ✅ `mev_pre_signal` flag |
| Gas velocity | ❌ | ✅ rising/falling fast |
| Price | Free | $0.0001/call |

---

## Live API

- Safe check: `https://rtt.phoenix-ai.work/api/v1/safe`
- Public feed (300s delay, free): `https://rtt.phoenix-ai.work/api/public-feed`
- Docs: `https://rtt.phoenix-ai.work/api/v1/openapi.json`
