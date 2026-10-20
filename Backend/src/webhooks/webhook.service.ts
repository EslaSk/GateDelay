import {
  Injectable,
  BadRequestException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { WebhookPayload, WebhookEvent, WebhookStatus } from './webhook.entity';

/** Placeholder values that must never be used as real secrets (BE-016). */
const FORBIDDEN_SECRETS = new Set(['default-secret', '']);

@Injectable()
export class WebhookService implements OnModuleInit {
  private readonly logger = new Logger(WebhookService.name);

  private readonly webhookEvents = new Map<string, WebhookEvent>();
  private readonly webhookStatuses = new Map<string, WebhookStatus>();

  /**
   * Reverse-lookup: providerEventId → internal eventId.
   * Enables O(1) deduplication without scanning the full event map (BE-018).
   */
  private readonly providerEventIndex = new Map<string, string>();

  private readonly maxRetries = 3;
  private readonly allowedTimestampDriftMs: number;

  /**
   * Ordered list of accepted HMAC secrets.
   * The first entry is the active signing secret; subsequent entries are
   * kept during rotation so in-flight requests signed with the old key
   * still verify (BE-016 rotation support).
   */
  private readonly acceptedSecrets: string[];

  constructor(private readonly config: ConfigService) {
    const primary = this.config.get<string>('WEBHOOK_SECRET') ?? '';

    // Optional rotation list: "newsecret,oldsecret" (comma-separated)
    const rotationRaw =
      this.config.get<string>('WEBHOOK_SECRET_ROTATION') ?? '';
    const rotationSecrets = rotationRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    this.acceptedSecrets = [primary, ...rotationSecrets].filter(Boolean);

    this.allowedTimestampDriftMs = Number(
      this.config.get<string>('WEBHOOK_TIMESTAMP_WINDOW_MS') ?? 5 * 60 * 1000,
    );
  }

  /**
   * BE-016: Fail closed at startup when the secret is missing or is the
   * well-known placeholder value.
   */
  onModuleInit(): void {
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';

    if (this.acceptedSecrets.length === 0) {
      throw new Error(
        '[WebhookService] WEBHOOK_SECRET is not configured. ' +
          'Set a strong secret before starting the server.',
      );
    }

    const primarySecret = this.acceptedSecrets[0];

    if (FORBIDDEN_SECRETS.has(primarySecret)) {
      throw new Error(
        '[WebhookService] WEBHOOK_SECRET is set to a known placeholder value ' +
          `("${primarySecret}"). Configure a strong secret.`,
      );
    }

    if (nodeEnv === 'production' || nodeEnv === 'staging') {
      if (primarySecret.length < 32) {
        throw new Error(
          '[WebhookService] WEBHOOK_SECRET must be at least 32 characters ' +
            'in production/staging environments.',
        );
      }
    }

    if (this.acceptedSecrets.length > 1) {
      this.logger.log(
        `Webhook secret rotation active: ${this.acceptedSecrets.length} accepted secrets.`,
      );
    }
  }

  /**
   * BE-017: Verify signature against the ORIGINAL raw request bytes.
   *
   * Signed message: `"${timestamp}.${rawBody}"` where rawBody is the exact
   * byte sequence received from the network — no re-serialisation.
   * Tries every accepted secret in order to support rotation (BE-016).
   */
  validateWebhookSignature(
    rawBody: Buffer,
    signature: string,
    timestamp: string,
    now = Date.now(),
  ): boolean {
    const timestampMs = Number(timestamp);
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(now - timestampMs) > this.allowedTimestampDriftMs
    ) {
      return false;
    }

    const actual = Buffer.from(signature, 'hex');

    for (const secret of this.acceptedSecrets) {
      const hash = createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest('hex');

      const expected = Buffer.from(hash, 'hex');

      if (
        expected.length === actual.length &&
        timingSafeEqual(expected, actual)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * BE-016/017/018: Process an inbound webhook delivery.
   *
   * @param rawBody         Original request bytes — signed before JSON parse.
   * @param signature       Hex HMAC from the provider.
   * @param timestamp       Unix-ms string from the provider.
   * @param providerEventId Stable identifier supplied by the provider (BE-018).
   */
  async processWebhook(
    rawBody: Buffer,
    signature: string,
    timestamp: string,
    providerEventId: string,
  ): Promise<WebhookStatus> {
    // BE-016 / BE-017: verify signature against raw bytes BEFORE parsing JSON
    if (!this.validateWebhookSignature(rawBody, signature, timestamp)) {
      throw new BadRequestException(
        'Invalid webhook signature or timestamp outside allowed window',
      );
    }

    // BE-018: idempotency check — return original result for duplicate deliveries
    const existingEventId = this.providerEventIndex.get(providerEventId);
    if (existingEventId !== undefined) {
      const existingStatus = this.webhookStatuses.get(existingEventId);
      if (existingStatus) {
        this.logger.log(
          `Duplicate delivery for providerEventId=${providerEventId}; ` +
            `returning original result (eventId=${existingEventId}).`,
        );
        return existingStatus;
      }
    }

    // BE-017: parse JSON only after signature passes
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
    } catch {
      throw new BadRequestException('Webhook body is not valid JSON');
    }

    // Register event with stable internal ID (BE-019)
    const eventId = randomUUID();
    const event: WebhookEvent = {
      id: eventId,
      providerEventId,
      payload,
      rawBody,
      signature,
      signedTimestamp: timestamp,
      timestamp: new Date(),
      status: 'pending',
      retryCount: 0,
      attemptHistory: [],
    };

    this.webhookEvents.set(eventId, event);
    // Index before side-effects so concurrent duplicates are caught (BE-018)
    this.providerEventIndex.set(providerEventId, eventId);

    return this._executeAttempt(event);
  }

  /**
   * BE-019: Retry on the original event record.
   *
   * - Event ID never changes across retries.
   * - retryCount increments monotonically; never resets.
   * - Bounded strictly by maxRetries.
   */
  async retryWebhook(eventId: string): Promise<WebhookStatus> {
    const event = this.webhookEvents.get(eventId);
    if (!event) {
      throw new BadRequestException('Webhook event not found');
    }

    if (event.retryCount >= this.maxRetries) {
      throw new BadRequestException(
        `Max retries (${this.maxRetries}) exceeded for event ${eventId}`,
      );
    }

    if (event.status === 'processed') {
      const cached = this.webhookStatuses.get(eventId);
      if (cached) return cached;
    }

    return this._executeAttempt(event);
  }

  /**
   * Runs one processing attempt on an existing WebhookEvent.
   * Mutates retryCount, status, and attemptHistory in place.
   * Both initial processing and explicit retries go through here (BE-019).
   */
  private async _executeAttempt(event: WebhookEvent): Promise<WebhookStatus> {
    const attemptNumber = event.retryCount + 1;
    const attemptedAt = new Date();

    try {
      await this.createMarketFromWebhook(event.payload);

      event.status = 'processed';
      event.attemptHistory.push({
        attemptNumber,
        attemptedAt,
        outcome: 'success',
      });

      const status: WebhookStatus = {
        eventId: event.id,
        providerEventId: event.providerEventId,
        status: 'processed',
        marketId: event.payload.marketId,
        timestamp: new Date(),
        message: 'Market created successfully',
      };

      this.webhookStatuses.set(event.id, status);
      return status;
    } catch (error: any) {
      return this._recordFailedAttempt(event, error, attemptNumber, attemptedAt);
    }
  }

  private _recordFailedAttempt(
    event: WebhookEvent,
    error: any,
    attemptNumber: number,
    attemptedAt: Date,
  ): WebhookStatus {
    const message: string = error?.message ?? String(error);

    event.lastError = message;
    event.retryCount = attemptNumber; // BE-019: always advance, never reset
    event.attemptHistory.push({
      attemptNumber,
      attemptedAt,
      outcome: 'failure',
      error: message,
    });

    event.status = event.retryCount >= this.maxRetries ? 'failed' : 'pending';

    const status: WebhookStatus = {
      eventId: event.id,
      providerEventId: event.providerEventId,
      status: event.status,
      marketId: event.payload.marketId,
      timestamp: new Date(),
      message: `Processing failed: ${message}. Attempt ${event.retryCount}/${this.maxRetries}`,
    };

    this.webhookStatuses.set(event.id, status);
    return status;
  }

  private async createMarketFromWebhook(
    payload: WebhookPayload,
  ): Promise<void> {
    if (
      !payload.marketId ||
      !payload.marketName ||
      !payload.outcomes ||
      payload.outcomes.length < 2
    ) {
      throw new BadRequestException('Invalid market payload');
    }

    // TODO: replace with actual MarketService call
    this.logger.log(
      `Creating market: ${payload.marketName} with outcomes: ${payload.outcomes.join(', ')}`,
    );
  }

  getWebhookStatus(eventId: string): WebhookStatus | undefined {
    return this.webhookStatuses.get(eventId);
  }

  getWebhookEvent(eventId: string): WebhookEvent | undefined {
    return this.webhookEvents.get(eventId);
  }

  getAllWebhookStatuses(): WebhookStatus[] {
    return Array.from(this.webhookStatuses.values());
  }
}
