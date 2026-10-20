export interface WebhookPayload {
  marketId: string;
  marketName: string;
  description: string;
  outcomes: string[];
  resolutionDate: Date;
  metadata?: Record<string, any>;
}

export interface WebhookEvent {
  id: string;

  /**
   * Provider-supplied stable event identifier (BE-018).
   * Used for idempotency: a second delivery with the same providerEventId
   * returns the original result without creating another market.
   */
  providerEventId: string;

  payload: WebhookPayload;

  /** Original raw request body bytes, kept for re-verification (BE-017). */
  rawBody: Buffer;

  signature: string;
  signedTimestamp: string;
  timestamp: Date;
  status: 'pending' | 'processed' | 'failed';

  /** Monotonically increasing attempt count — never reset on retry (BE-019). */
  retryCount: number;

  /** Full attempt history for observability (BE-019). */
  attemptHistory: Array<{
    attemptNumber: number;
    attemptedAt: Date;
    outcome: 'success' | 'failure';
    error?: string;
  }>;

  lastError?: string;
}

export interface WebhookStatus {
  eventId: string;
  providerEventId: string;
  status: 'pending' | 'processed' | 'failed';
  marketId: string;
  timestamp: Date;
  message: string;
}
