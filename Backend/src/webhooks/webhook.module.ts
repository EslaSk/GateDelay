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
