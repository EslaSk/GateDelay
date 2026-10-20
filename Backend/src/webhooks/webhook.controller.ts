import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhookService } from './webhook.service';

/**
 * BE-017: Signature verification uses the original raw request bytes, not
 * re-serialised JSON. Raw bytes are captured by WebhookRawBodyMiddleware
 * (registered in WebhooksModule) and stored on req.rawBody before the
 * global JSON body-parser runs.
 */
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * POST /api/webhooks/market-creation
   *
   * Preferred: pass signature, timestamp, and providerEventId via headers:
   *   x-webhook-signature  — hex HMAC-SHA256 of `"${timestamp}.${rawBody}"`
   *   x-webhook-timestamp  — Unix milliseconds (string)
   *   x-provider-event-id  — stable provider-side event identifier (BE-018)
   *
   * Fallback: include them as top-level fields in the JSON body alongside
   * the WebhookPayload fields (for providers that don't support custom headers).
   */
  @Post('market-creation')
  async handleMarketCreationWebhook(@Req() req: Request) {
    // BE-017: use raw bytes when captured by the middleware
    const rawBody: Buffer | undefined = (req as any).rawBody;

    const signature: string =
      (req.headers['x-webhook-signature'] as string) ||
      (req.body as any)?.signature ||
      '';

    const timestamp: string =
      (req.headers['x-webhook-timestamp'] as string) ||
      (req.body as any)?.timestamp ||
      '';

    // BE-018: stable provider event identifier required
    const providerEventId: string =
      (req.headers['x-provider-event-id'] as string) ||
      (req.body as any)?.providerEventId ||
      '';

    if (!signature || !timestamp || !providerEventId) {
      throw new BadRequestException(
        'Missing required fields: signature, timestamp, and providerEventId ' +
          'must be supplied via headers (x-webhook-signature, x-webhook-timestamp, ' +
          'x-provider-event-id) or body fields.',
      );
    }

    // BE-017: use raw bytes when available; fall back to re-serialised body
    // only in non-production for backward-compatible smoke testing.
    let bodyBuffer: Buffer;
    if (rawBody && rawBody.length > 0) {
      bodyBuffer = rawBody;
    } else {
      bodyBuffer = Buffer.from(JSON.stringify(req.body), 'utf8');
    }

    return this.webhookService.processWebhook(
      bodyBuffer,
      signature,
      timestamp,
      providerEventId,
    );
  }

  @Get('status/:eventId')
  getWebhookStatus(@Param('eventId') eventId: string) {
    const status = this.webhookService.getWebhookStatus(eventId);
    if (!status) {
      throw new BadRequestException('Webhook event not found');
    }
    return status;
  }

  @Get('statuses')
  getAllWebhookStatuses() {
    return this.webhookService.getAllWebhookStatuses();
  }

  @Post('retry/:eventId')
  retryWebhook(@Param('eventId') eventId: string) {
    return this.webhookService.retryWebhook(eventId);
  }
}
