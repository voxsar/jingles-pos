import { Router, Request, Response } from 'express';
import prisma from '../prisma';

const router = Router();

// Search products by name, SKU, or barcode
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query as { q: string };
    if (!q) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }

    const products = await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: q } },
          { sku: { contains: q } },
          { barcode: q },
        ],
      },
      include: { batchPrices: true },
      take: 20,
    });

    return res.json(products);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Scan barcode
router.get('/barcode/:barcode', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { barcode: req.params.barcode },
      include: { batchPrices: true },
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json(product);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// List all products
router.get('/', async (_req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      include: { batchPrices: true },
    });
    return res.json(products);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Create product
router.post('/', async (req: Request, res: Response) => {
  try {
    const { sku, name, barcode, price, description, batchPrices } = req.body;
    const product = await prisma.product.create({
      data: {
        sku,
        name,
        barcode,
        price,
        description,
        batchPrices: batchPrices
          ? { create: batchPrices }
          : undefined,
      },
      include: { batchPrices: true },
    });
    return res.status(201).json(product);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
