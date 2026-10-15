export declare const RECEIPT_KEYS_URL: string;
export interface ReceiptKey { kty: "OKP"; crv: "Ed25519"; x: string; kid?: string; alg?: string; use?: string }
export interface VerifyReceiptOptions { publicKey?: string | ReceiptKey | { keys: ReceiptKey[] } | ReceiptKey[]; keysUrl?: string; fetch?: (input: any, init?: any) => Promise<Response> }
export declare function canonicalize(value: any): string;
export declare function receiptSigningInput(receipt: Record<string, any>): Uint8Array;
export declare function verifyReceipt(receipt: Record<string, any>, opts?: VerifyReceiptOptions): Promise<{ valid: boolean; kid: string | null; reason: string }>;
