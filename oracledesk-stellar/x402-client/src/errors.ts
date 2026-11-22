export class PaymentRequired extends Error {
  constructor(
    public readonly www_authenticate: string,
    public readonly paymentDetails: Record<string, unknown>,
  ) {
    super("402 Payment Required");
    this.name = "PaymentRequired";
  }
}

export class PaymentError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "PaymentError";
  }
}

export class TraceNotFound extends Error {
  constructor(public readonly traceId: string) {
    super(`Trace not found: ${traceId}`);
    this.name = "TraceNotFound";
  }
}

export class VerificationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationFailed";
  }
}
