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

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors());
app.use('/api/pos/client-errors', express.json({ limit: '32kb' }), clientErrorsRouter);
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: 'ok' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error' });
  }
});

app.use('/api/pos/auth', authRouter);
app.use('/api/pos', posRouter);

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
  });

  if (isLocalPosBackendMode()) {
    const deviceId = getLocalPosDeviceId();
    const terminalId = getLocalPosTerminalId();

    const runSync = async () => {
      try {
        await syncWithUpstream({ deviceId, terminalId });
      } catch (error) {
        console.error('Background local sync failed', error);
      }
    };

    void runSync();
    setInterval(() => {
      void runSync();
    }, 20_000);
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start backend server', error);
    process.exitCode = 1;
  });
}

export default app;
