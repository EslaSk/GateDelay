const cron = require('node-cron');
const { syncQueue, syncMarketData, getSyncStatus } = require('../services/syncService');
const { log, withJobContext } = require('../utils/correlation');

const startSyncWorker = () => {
  syncQueue.process(async (job) => {
    return withJobContext(
      'syncWorker.process',
      { requestId: job.data?.requestId, correlationId: job.data?.correlationId },
      async ({ requestId }) => {
        log('info', 'Processing sync job', { requestId, jobId: job.id });
        return await syncMarketData({ ...job.data, requestId });
      },
    );
  });

  syncQueue.on('completed', (job, result) => {
    log('info', 'Sync job completed', {
      requestId: job.data?.requestId,
      jobId: job.id,
      syncedItems: result.data.length,
    });
  });

  syncQueue.on('failed', (job, error) => {
    log('error', 'Sync job failed', {
      requestId: job.data?.requestId,
      jobId: job.id,
      error: error.message,
    });
  });

  cron.schedule('*/10 * * * *', async () => {
    await withJobContext('syncWorker.schedule', {}, async ({ requestId }) => {
      log('info', 'Scheduled sync job triggered', { requestId });
      await syncMarketData({ incremental: true, requestId });
    });
  });

  log('info', 'Market data sync worker started');
};

module.exports = { startSyncWorker };
