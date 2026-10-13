type Hook = (ctx: { paymentRequired: any; selectedRequirements: any }) => Promise<void | { abort: true; reason: string }>;
type MockFetch = ((input: any, init?: any) => Promise<Response>) & { calls: number };
export declare const SAMPLE_REQUIREMENT: Readonly<Record<string, any>>;
export declare function sampleContext(url?: string): { paymentRequired: any; selectedRequirements: any };
export declare const mocks: { counting(): MockFetch; hanging(): MockFetch; empty(): MockFetch; skip(code?: string): MockFetch };
/** Registers four contract tests with `test` (node:test `test` or vitest `it`). */
export declare function spotcheckContract(
  test: (name: string, fn: () => Promise<void>) => unknown,
  build: (env: { enabled: boolean; fetch: MockFetch; timeoutMs: number }) => Hook | undefined | Promise<Hook | undefined>,
  opts?: { timeoutMs?: number; slackMs?: number; name?: string },
): void;
