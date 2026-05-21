import prisma from '../prisma';

const HOST_SYNC_AUTH_KEY = 'hostSyncAuth';

export const HOST_SYNC_AUTH_REQUIRED_ERROR =
  'Host sync authentication is required. Reconnect host sync.';

type ConfigStore = {
  configEntry: {
    findUnique: typeof prisma.configEntry.findUnique;
    upsert: typeof prisma.configEntry.upsert;
    deleteMany: typeof prisma.configEntry.deleteMany;
  };
};

type StoredSyncAuth = {
  token: string;
  userId?: string;
  identity?: string;
  updatedAt: string;
};

function parseStoredSyncAuth(value: string | null | undefined): StoredSyncAuth | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const token = 'token' in parsed ? parsed.token : null;
    const userId = 'userId' in parsed ? parsed.userId : null;
    const identity = 'identity' in parsed ? parsed.identity : null;
    const updatedAt = 'updatedAt' in parsed ? parsed.updatedAt : null;

    if (typeof token !== 'string' || !token.trim()) {
      return null;
    }

    return {
      token: token.trim(),
      userId: typeof userId === 'string' && userId.trim() ? userId.trim() : undefined,
      identity: typeof identity === 'string' && identity.trim() ? identity.trim() : undefined,
      updatedAt:
        typeof updatedAt === 'string' && updatedAt.trim()
          ? updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function readStoredSyncAuth(store: ConfigStore = prisma): Promise<StoredSyncAuth | null> {
  const row = await store.configEntry.findUnique({
    where: { key: HOST_SYNC_AUTH_KEY },
  });

  return parseStoredSyncAuth(row?.value);
}

export async function storeStoredSyncAuth(
  input: { token: string; userId?: string | null; identity?: string | null },
  store: ConfigStore = prisma,
) {
  const value = JSON.stringify({
    token: input.token.trim(),
    userId: input.userId?.trim() || undefined,
    identity: input.identity?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  });

  await store.configEntry.upsert({
    where: { key: HOST_SYNC_AUTH_KEY },
    create: {
      key: HOST_SYNC_AUTH_KEY,
      value,
    },
    update: {
      value,
    },
  });
}

export async function clearStoredSyncAuth(store: ConfigStore = prisma) {
  await store.configEntry.deleteMany({
    where: { key: HOST_SYNC_AUTH_KEY },
  });
}
