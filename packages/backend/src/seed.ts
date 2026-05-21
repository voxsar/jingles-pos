import prisma from './prisma';
import {
  SAMPLE_BRANCHES,
  SAMPLE_CUSTOMERS,
  SAMPLE_TERMINALS,
  SAMPLE_USERS,
} from '@jingles/shared';

export async function ensureSeedData(): Promise<void> {
  const [branchCount, userCount, customerCount, terminalCount] = await Promise.all([
    prisma.branch.count(),
    prisma.pOSUser.count(),
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
        email: user.email ?? null,
        name: user.name,
        initials: user.initials,
        role: user.role,
        pin: user.pin ?? null,
      })),
    });
  } else {
    for (const user of SAMPLE_USERS) {
      await prisma.pOSUser.updateMany({
        where: { id: user.id, email: null },
        data: { email: user.email ?? null },
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
}
