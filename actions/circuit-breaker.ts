import { ActionFn, Context, Event } from "@tenderly/actions";
import { ethers } from "ethers";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Phoenix Zero endpoint
const PHOENIX_URL = "https://rtt.phoenix-ai.work/api/v1/safe";

// Minimal ABI — only pause()
const PAUSE_ABI = ["function pause() external"];

// ─── MAIN ACTION ────────────────────────────────────────────────────────────
export const circuitBreaker: ActionFn = async (context: Context, event: Event) => {
    const rpcUrl        = await context.secrets.get("RPC_URL");
    const relayerKey    = await context.secrets.get("RELAYER_PRIVATE_KEY");
    const paymentKey    = await context.secrets.get("PHOENIX_PAYMENT_KEY");
    const contractAddr  = await context.secrets.get("PAUSABLE_CONTRACT_ADDRESS");
    const alertWebhook  = await context.secrets.get("ALERT_WEBHOOK_URL");

    // ── Step 1: check Phoenix Zero ──────────────────────────────────────────
    let safe = true;
    let phoenixData: Record<string, unknown> = {};

    try {
        const result = await callPhoenixZero(paymentKey);
        safe        = result.safe;
        phoenixData = result.data;
    } catch (err) {
        // FAIL-OPEN: если Phoenix Zero недоступен — не паузим, только алерт
        await sendAlert(alertWebhook,
            `⚠️ Phoenix Zero unreachable. Protocol continues normally.\n${err}`);
        return;
    }

    // ── Step 2: pause if unsafe ─────────────────────────────────────────────
    if (!safe) {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet   = new ethers.Wallet(relayerKey, provider);
        const contract = new ethers.Contract(contractAddr, PAUSE_ABI, wallet);

        const tx = await contract.pause();
        await tx.wait();

        await sendAlert(alertWebhook,
            `🚨 CIRCUIT BREAKER TRIGGERED\n` +
            `TX: ${tx.hash}\n` +
            `base_p99_ms: ${phoenixData.base_p99_ms ?? "?"}\n` +
            `gas_pressure: ${phoenixData.gas_pressure ?? "?"}\n` +
            `mev_pre_signal: ${phoenixData.mev_pre_signal ?? false}\n` +
            `→ pause() executed on ${contractAddr}`
        );
    }
};

// ─── x402 PAYMENT FLOW ──────────────────────────────────────────────────────
// paymentKey is a separate low-balance key stored in Tenderly Secrets.
// It only holds enough USDC for micropayments ($0.0001 per call).
// This is intentionally separate from RELAYER_PRIVATE_KEY (which calls pause).
// Why: principle of least privilege — payment key never touches your contract.
async function callPhoenixZero(paymentKey: string): Promise<{ safe: boolean; data: Record<string, unknown> }> {
    // First call — get 402 with payment requirements
    const probe = await fetch(PHOENIX_URL);

    if (probe.status === 200) {
        const data = await probe.json();
        return { safe: data.safe === true, data };
    }

    if (probe.status !== 402) {
        throw new Error(`Unexpected status ${probe.status}`);
    }

    // Parse x402 payment requirements
    const req = await probe.json();
    const opts = req.accepts?.[0];
    if (!opts) throw new Error("No payment options in 402 response");

    // Sign and send payment
    const account = privateKeyToAccount(paymentKey as `0x${string}`);
    const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(),
    });

    // Build EIP-3009 transferWithAuthorization for USDC
    const paymentHeader = await buildX402PaymentHeader(walletClient, opts);

    // Second call — with payment proof
    const paid = await fetch(PHOENIX_URL, {
        headers: { "X-PAYMENT": paymentHeader },
    });

    if (!paid.ok) throw new Error(`Phoenix Zero paid request failed: ${paid.status}`);

    const data = await paid.json();
    return { safe: data.safe === true, data };
}

// ─── EIP-3009 signing (x402 exact scheme) ───────────────────────────────────
async function buildX402PaymentHeader(walletClient: ReturnType<typeof createWalletClient>, opts: Record<string, unknown>): Promise<string> {
    const now   = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;

    const sig = await walletClient.signTypedData({
        domain: {
            name:              "USD Coin",
            version:           "2",
            chainId:           8453,
            verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        },
        types: {
            TransferWithAuthorization: [
                { name: "from",        type: "address" },
                { name: "to",         type: "address" },
                { name: "value",      type: "uint256" },
                { name: "validAfter", type: "uint256" },
                { name: "validBefore",type: "uint256" },
                { name: "nonce",      type: "bytes32" },
            ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
            from:        walletClient.account!.address,
            to:          opts.pay_to as `0x${string}`,
            value:       BigInt(opts.price as string),
            validAfter:  BigInt(now - 30),
            validBefore: BigInt(now + 300),
            nonce:       nonce as `0x${string}`,
        },
    });

    return Buffer.from(JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453",
        payload: {
            signature:   sig,
            authorization: {
                from:        walletClient.account!.address,
                to:          opts.pay_to,
                value:       opts.price,
                validAfter:  (now - 30).toString(),
                validBefore: (now + 300).toString(),
                nonce,
            },
        },
    })).toString("base64");
}

// ─── ALERT ──────────────────────────────────────────────────────────────────
async function sendAlert(webhookUrl: string, message: string): Promise<void> {
    await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
    });
}
