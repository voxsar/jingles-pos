import prisma from './prisma';
import {
  SAMPLE_BRANCHES,
  SAMPLE_CATEGORIES,
  SAMPLE_CUSTOMERS,
  SAMPLE_PRODUCTS,
  SAMPLE_TERMINALS,
  SAMPLE_USERS,
} from '@jingles/shared';

export async function ensureSeedData(): Promise<void> {
  const [branchCount, userCount, categoryCount, productCount, customerCount, terminalCount] = await Promise.all([
    prisma.branch.count(),
    prisma.pOSUser.count(),
    prisma.category.count(),
    prisma.product.count(),
    prisma.customer.count(),
    prisma.terminal.count(),
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
    await prisma.pOSUser.createMany({
      data: SAMPLE_USERS.map((user) => ({
        id: user.id,
        code: user.code,
        name: user.name,
        initials: user.initials,
        role: user.role,
        pin: user.pin ?? null,
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

  if (productCount === 0) {
    for (const product of SAMPLE_PRODUCTS) {
      await prisma.product.create({
        data: {
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
          batchPrices: {
            create: product.priceTiers.map((tier) => ({
              id: tier.id,
              label: tier.label,
              minQty: tier.minQty ?? 0,
              price: tier.price,
              priority: tier.priority,
              isDefault: tier.isDefault ?? false,
            })),
          },
        },
      });
    }
  }
}
