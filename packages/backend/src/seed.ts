import bcrypt from 'bcryptjs';
import prisma from './prisma';
import {
  SAMPLE_BRANCHES,
  SAMPLE_CATEGORIES,
  SAMPLE_CUSTOMERS,
  SAMPLE_PRODUCTS,
  SAMPLE_TERMINALS,
  SAMPLE_USERS,
} from '@jingles/shared';

let seedReady = false;
let seedPromise: Promise<void> | null = null;

async function ensureSeedDataInternal(): Promise<void> {
  const [branchCount, userCount, customerCount, terminalCount, categoryCount, productCount] = await Promise.all([
    prisma.branch.count(),
    prisma.pOSUser.count(),
    prisma.customer.count(),
    prisma.terminal.count(),
    prisma.category.count(),
    prisma.product.count(),
  ]);

  if (branchCount === 0) {
    await prisma.branch.createMany({
      data: SAMPLE_BRANCHES.map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
      })),
    });
  }

  if (terminalCount === 0) {
    await prisma.terminal.createMany({
      data: SAMPLE_TERMINALS.map((terminal) => ({
        id: terminal.id,
        code: terminal.code,
        name: terminal.name,
        branchId: terminal.branchId,
      })),
    });
  }

  if (userCount === 0) {
    const seededUsers = await Promise.all(
      SAMPLE_USERS.map(async (user) => ({
        id: user.id,
        code: user.code,
        email: user.email ?? null,
        name: user.name,
        initials: user.initials,
        role: user.role,
        pin: user.pin ?? null,
        passwordHash: user.pin ? await bcrypt.hash(user.pin, 10) : null,
      })),
    );

    await prisma.pOSUser.createMany({
      data: seededUsers,
    });
  } else {
    for (const user of SAMPLE_USERS) {
      const passwordHash = user.pin ? await bcrypt.hash(user.pin, 10) : null;
      await prisma.pOSUser.updateMany({
        where: { id: user.id, email: null },
        data: {
          email: user.email ?? null,
          ...(passwordHash ? { passwordHash } : {}),
        },
      });
    }

    const legacyUsers = await prisma.pOSUser.findMany({
      where: {
        passwordHash: null,
        NOT: { pin: null },
      },
      select: {
        id: true,
        pin: true,
      },
    });

    for (const user of legacyUsers) {
      if (!user.pin) {
        continue;
      }

      await prisma.pOSUser.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(user.pin, 10),
        },
      });
    }
  }

  if (customerCount === 0) {
    await prisma.customer.createMany({
      data: SAMPLE_CUSTOMERS.map((customer) => ({
        id: customer.id,
        code: customer.code,
        name: customer.name,
        tier: customer.tier,
        phone: customer.phone ?? null,
        email: customer.email ?? null,
      })),
    });
  }

  if (categoryCount === 0) {
    await prisma.category.createMany({
      data: SAMPLE_CATEGORIES.map((category) => ({
        id: category.id,
        name: category.name,
        icon: category.icon,
        sortOrder: category.sortOrder,
      })),
    });
  }

  if (productCount === 0) {
    await prisma.product.createMany({
      data: SAMPLE_PRODUCTS.map((product) => ({
        id: product.id,
        sku: product.sku,
        barcode: product.barcode ?? null,
        name: product.name,
        price: product.priceTiers[0]?.price ?? 0,
        categoryId: product.categoryId,
        subcategory: product.subcategory,
        packSize: product.packSize,
        unitLabel: product.unitLabel,
        stockOnHand: product.stockOnHand,
        description: product.description ?? null,
        lastVectorClock: '{}',
      })),
    });

    const batchPrices = SAMPLE_PRODUCTS.flatMap((product) =>
      product.priceTiers.map((tier) => ({
        id: tier.id,
        productId: product.id,
        label: tier.label,
        price: tier.price,
        priority: tier.priority,
        minQty: tier.minQty ?? 0,
        isDefault: tier.isDefault ?? false,
      })),
    );

    if (batchPrices.length > 0) {
      await prisma.batchPrice.createMany({ data: batchPrices });
    }
  }
}

export async function ensureSeedData(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    await ensureSeedDataInternal();
    return;
  }

  if (seedReady) {
    return;
  }

  if (!seedPromise) {
    seedPromise = ensureSeedDataInternal()
      .then(() => {
        seedReady = true;
      })
      .finally(() => {
        seedPromise = null;
      });
  }

  await seedPromise;
}
