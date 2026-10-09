export interface SpotDecision { url: string; verdict: "pay" | "skip" | "recheck" | "unavailable"; reason: string; allowed: boolean; checked: boolean; raw?: any }
export interface SpotCheckOptions {
  /** your client id (gets the free daily check; first-router ids get a 1,000-check pool) */
  client?: string;
  /** a fetch that can pay Spot-Check's own x402 price, e.g. wrapFetchWithPayment(fetch, client) */
  payFetch?: (input: any, init?: any) => Promise<Response>;
  /** max USD to pay for one check (default 0.05) */
  maxCheckUsd?: number;
  /** what to do on verdict "recheck" (default "block") */
  onRecheck?: "block" | "allow";
  /** what to do when Spot-Check cannot answer (default "allow" so an outage never stops your payments) */
  onUnavailable?: "allow" | "block";
  /** your listing for this URL: the price / payTo / network you expect */
  expected?: (url: string, intent: { network: string | null; payTo: string | null; priceUsd: number | null } | null) => { price?: number; payTo?: string; network?: string } | undefined | Promise<{ price?: number; payTo?: string; network?: string } | undefined>;
  onDecision?: (d: SpotDecision) => void | Promise<void>;
  cacheTtlMs?: number;
  timeoutMs?: number;
  endpoint?: string;
  ref?: string;
  fetch?: typeof fetch;
}
export declare class SpotCheckBlockedError extends Error { decision: SpotDecision }
export declare const DEFAULT_ENDPOINT: string;
export declare function spotCheckFetch<F extends (input: any, init?: any) => Promise<Response>>(fetchImpl?: F, opts?: SpotCheckOptions): F;
export declare function spotCheckAxios<A>(instance: A, opts?: SpotCheckOptions): A;
export declare function createSpotChecker(opts?: SpotCheckOptions): (url: string, o?: { method?: string; intent?: any }) => Promise<SpotDecision>;
export declare function checkBeforePay(url: string, o?: SpotCheckOptions & { price?: number; payTo?: string; network?: string; method?: string }): Promise<SpotDecision>;
export declare function readPaymentIntent(headerValue: string): { network: string | null; payTo: string | null; priceUsd: number | null } | null;
export default spotCheckFetch;
