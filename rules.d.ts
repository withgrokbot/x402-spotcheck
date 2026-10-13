export type SkipCode = "price_mismatch" | "pay_to_mismatch" | "network_mismatch" | "asset_not_usdc" | "bad_challenge";
export interface Listing { price?: number; payTo?: string; network?: string }
export interface RulesOptions { listing?: Listing; solana?: boolean; tolerance?: number }
export interface Judgement { verdict: "pay" | "skip"; reason_code: SkipCode | "price_ok" | "price_below_listing" | null; reason: string; checked: boolean }
export declare const RULES_VERSION: string;
export declare const SKIP_CODES: readonly SkipCode[];
export declare const BASE_MAINNET: string;
export declare const SOLANA_MAINNET: string;
export declare const USDC: Readonly<Record<string, string>>;
export declare function caip(network: string): string;
export declare function judgeRequirement(requirement: any, opts?: RulesOptions): Judgement;
export declare function judge402(paymentRequired: any, opts?: RulesOptions): Judgement & { results: Judgement[]; kept: any[] };
export declare function rulesBeforePaymentHook(opts?: Omit<RulesOptions, "listing"> & { listing?: Listing | ((url: string | undefined, requirement: any) => Listing | undefined | Promise<Listing | undefined>); onDecision?: (d: Judgement, ctx: any) => void | Promise<void> }): (ctx: { paymentRequired: any; selectedRequirements: any }) => Promise<void | { abort: true; reason: string }>;
export default judgeRequirement;
