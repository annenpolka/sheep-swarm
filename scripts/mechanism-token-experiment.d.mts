export interface TokenSeriesRun {
  id: string; family: string; method: string; observedTokens: number; calls: number; success: boolean;
}
export interface TokenSeriesReport {
  format: 1; kind: "mechanism-token-series"; status: "completed" | "stopped"; stopReason: string | null;
  maxTokens: number; reserveTokensPerCall: number; maxCalls: number; observedTokens: number; calls: number;
  usageComplete: boolean; pending: { id: string; args: string[] } | null; failedAttempt: TokenSeriesRun | null;
  runtime: string; metaRuntime: string; families: string[]; methods: string[]; runs: TokenSeriesRun[];
}
export function runTokenSeries(argv: string[],
  deps?: { runChild?: (args: string[], logPath: string) => Promise<number | string | null> }): Promise<TokenSeriesReport>;
