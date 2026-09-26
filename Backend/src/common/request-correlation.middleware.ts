import { Injectable, NestMiddleware } from '@nestjs/common';

const {
  expressCorrelationMiddleware,
} = require('../../utils/correlation');

@Injectable()
export class RequestCorrelationMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    expressCorrelationMiddleware(req, res, next);
  }
}
