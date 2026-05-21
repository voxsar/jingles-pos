import cors from 'cors';
import express from 'express';
import authRouter from './routes/auth';
import posRouter from './routes/pos';
import { ensureSeedData } from './seed';
import { syncSharedCatalogProjection } from './sharedInventory';

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req, res) => {
  try {
    await ensureSeedData();
    return res.json({ status: 'ok' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error' });
  }
});

app.use('/api/pos/auth', authRouter);
app.use('/api/pos', posRouter);

async function startServer() {
  await ensureSeedData();
  await syncSharedCatalogProjection({ force: true });
  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start backend server', error);
    process.exitCode = 1;
  });
}

export default app;
