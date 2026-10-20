/**
 * Public-facing TypeScript interfaces for the webhook subsystem.
 *
 * These are the shapes returned by the service / controller.  The durable
 * storage types live in webhook.schema.ts (Mongoose documents).
 */

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
  payload: WebhookPayload;
  signature: string;
  signedTimestamp: string;
  timestamp: Date;
  status: 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter';
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  /** Present once a market was successfully created */
  resultMarketId?: string;
}

export interface WebhookAttemptRecord {
  eventId: string;
  attemptNumber: number;
  outcome: 'success' | 'failure';
  errorMessage?: string;
  errorName?: string;
  retryable?: boolean;
  createdMarketId?: string;
  attemptedAt: Date;
}

export interface WebhookStatus {
  eventId: string;
  status: 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter';
  marketId: string;
  resultMarketId?: string;
  timestamp: Date;
  message: string;
  attemptCount: number;
  maxAttempts: number;
}
