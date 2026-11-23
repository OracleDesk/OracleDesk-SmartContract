export { fetchAndVerifyTrace } from "./client.js";
export { verifyTraceOnChain } from "./verify.js";
export { PaymentRequired, PaymentError, TraceNotFound, VerificationFailed } from "./errors.js";
export type { TraceApiClientConfig, TraceApiSigner, FetchedTrace } from "./client.js";
export type { RegistryClient, VerificationResult, VerifyOptions } from "./verify.js";
