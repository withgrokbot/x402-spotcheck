export declare const PAYMENT_STATUS_URL: string;
export declare const AFTER_PAY_TIMEOUT_MS: number;
export interface AfterPayRef { paymentPayload?: string; txHash?: string; from?: string; nonce?: string; validBefore?: number | string; sellerUrl?: string; terms?: { amount?: string; payTo?: string; asset?: string; network?: string } }
export interface AfterPayResult {
  status: "landed" | "not_landed" | "pending" | "canceled" | "unknown";
  reason?: string;
  safe_to_retry_same_payload: true;
  safe_to_resign: boolean;
  why?: string;
  wait_until?: string | null;
  tx?: any; terms_match?: any; claim?: any; receipt?: any; receipt_verified?: boolean; error?: string; [k: string]: any;
}
export interface AfterPayOptions { url?: string; fetch?: typeof fetch; timeoutMs?: number; client?: string; verify?: boolean; publicKey?: any; paymentHeader?: string; apiKey?: string; onResult?: (r: AfterPayResult, ctx: { url: string; response: Response | null; error: any; paymentPayload?: string | null }) => void | Promise<void> }
export declare function afterPay(ref: AfterPayRef, opts?: AfterPayOptions): Promise<AfterPayResult>;
export declare function needsAfterPay(resOrError: any): boolean;
