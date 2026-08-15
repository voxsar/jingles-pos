import cors from 'cors';
import express from 'express';
import authRouter from './routes/auth';
import clientErrorsRouter from './routes/clientErrors';
import { getLocalPosDeviceId, getLocalPosTerminalId, isLocalPosBackendMode } from './localMode';
import posRouter from './routes/pos';
import prisma from './prisma';
import { ensureSeedData } from './seed';
import { ensureLocalCatalogSearchIndex } from './services/localCatalog';
import { ensureLocalSchemaCompat } from './services/schemaCompat';
import { syncWithUpstream } from './services/posSync';
import { syncSharedCatalogProjection } from './sharedInventory';
import {
  flushPendingServerErrorUploads,
  reportBackgroundServerError,
  respondWithServerError,
} from './services/serverErrorLog';

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors());
app.use('/api/pos/client-errors', express.json({ limit: '32kb' }), clientErrorsRouter);
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: 'ok' });
  } catch (error) {
    return respondWithServerError(req, res, error, 'Backend health check failed');
  }
});

app.use('/api/pos/auth', authRouter);
app.use('/api/pos', posRouter);
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => (
  respondWithServerError(req, res, error, 'Unhandled backend request failure')
));

async function startServer() {
  await ensureLocalSchemaCompat();
  await ensureSeedData();

  if (isLocalPosBackendMode()) {
    await ensureLocalCatalogSearchIndex();
  } else {
    await syncSharedCatalogProjection({ force: true });
  }

  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    void flushPendingServerErrorUploads();
  });

  if (isLocalPosBackendMode()) {
    const deviceId = getLocalPosDeviceId();
    const terminalId = getLocalPosTerminalId();

    const runSync = async () => {
      try {
        await syncWithUpstream({ deviceId, terminalId });
      } catch (error) {
        await reportBackgroundServerError(error, 'backend.sync.background', { deviceId, terminalId });
      }
    };

    void runSync();
    setInterval(() => {
      void runSync();
    }, 20_000);
  }
}

if (require.main === module) {
  process.on('uncaughtException', (error) => {
    void reportBackgroundServerError(error, 'backend.process.uncaught-exception')
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    void reportBackgroundServerError(reason, 'backend.process.unhandled-rejection');
  });
  startServer().catch((error) => {
    void reportBackgroundServerError(error, 'backend.startup')
      .finally(() => { process.exitCode = 1; });
  });
}

export default app;
