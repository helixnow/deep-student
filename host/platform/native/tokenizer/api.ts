/** dstu-util/utils/token_budget.rs; desktop tokenizer_tiktoken feature. */
export type TokenEncoding = 'cl100k_base' | 'o200k_base';
export interface NativeTokenizer {
  encode(text: string, modelHint?: string | null): number[];
  estimateTokensWithModel(text: string, modelHint?: string | null): number;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeTokenizer: NativeTokenizer }
}
