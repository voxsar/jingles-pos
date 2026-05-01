import express from 'express';
import cors from 'cors';
import productsRouter from './routes/products';
import posRouter from './routes/pos';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/products', productsRouter);
app.use('/api/pos', posRouter);

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

export default app;
