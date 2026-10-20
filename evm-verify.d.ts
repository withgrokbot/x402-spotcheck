export interface SettlementCheck { claim: any; reservation: { asset: string; payTo: string; amount: bigint | string }; authorization: { from: string; nonce: string; validBefore?: string | number } }
export type SettlementVerdict = { ok: true; status: "landed" | "not_landed"; txHash?: string; confirmations?: number } | { ok: false; reason: string };
/** Service-side on-chain check of a client-reported payment-status (EVM, EIP-3009). */
export declare function createEvmSettlementVerifier(opts: { rpcUrl: string; fetch?: typeof fetch; minConfirmations?: number; timeoutMs?: number; now?: () => number }): (c: SettlementCheck) => Promise<SettlementVerdict>;
export declare const EVENT_TOPICS: Readonly<{ TRANSFER: string; AUTH_USED: string; AUTH_STATE: string }>;
