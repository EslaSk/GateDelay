import {
  Module,
  NestModule,
  MiddlewareConsumer,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { WebhookRawBodyMiddleware } from './webhook-raw-body.middleware';

@Module({
  /**
   * ConfigModule is imported explicitly so ConfigService is available when
   * this module is tested in isolation. In the full app it is already global
   * via AppModule.
   */
  imports: [ConfigModule],
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import {
  WebhookEventRecord,
  WebhookEventSchema,
  WebhookAttempt,
  WebhookAttemptSchema,
} from './webhook.schema';
import { MarketsModule } from '../markets/markets.module';

@Module({
  imports: [
    // Durable event + attempt storage (fixes in-memory-only persistence).
    // webhook_events  — one document per accepted delivery
    // webhook_attempts — one document per processing attempt
    MongooseModule.forFeature([
      { name: WebhookEventRecord.name, schema: WebhookEventSchema },
      { name: WebhookAttempt.name, schema: WebhookAttemptSchema },
    ]),
    // Exposes MarketResolverService so createMarketFromWebhook can call
    // registerMarket() instead of just logging.
    MarketsModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhooksModule implements NestModule {
  /**
   * BE-017: Register the raw-body capture middleware only on the
   * market-creation endpoint so other routes are unaffected.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(WebhookRawBodyMiddleware)
      .forRoutes({
        path: 'webhooks/market-creation',
        method: RequestMethod.POST,
      });
  }
}
