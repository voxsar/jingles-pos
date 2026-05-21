import prisma from '../prisma';

const LOCAL_SESSION_TOKEN_KEY = 'localSessionToken';
const AUTH_USER_KEY = 'authUser';
const LEGACY_AUTH_TOKEN_KEY = 'authToken';

type ConfigStore = {
  configEntry: {
    findMany: typeof prisma.configEntry.findMany;
    upsert: typeof prisma.configEntry.upsert;
    deleteMany: typeof prisma.configEntry.deleteMany;
  };
};

export type CachedAuthUser = {
  id: string;
  code: string;
  email?: string | null;
  role: string;
};

type StoredAuthSession = {
  token: string;
  user: CachedAuthUser;
};

function isCachedAuthUser(value: unknown): value is CachedAuthUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedAuthUser).id === 'string' &&
    typeof (value as CachedAuthUser).code === 'string' &&
    typeof (value as CachedAuthUser).role === 'string'
  );
}

function parseCachedAuthUser(value: string | null | undefined): CachedAuthUser | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isCachedAuthUser(parsed)) {
      return null;
    }

    return {
      id: parsed.id,
      code: parsed.code,
      email: typeof parsed.email === 'string' && parsed.email.trim() ? parsed.email.trim() : undefined,
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

export async function readStoredAuthSession(store: ConfigStore = prisma): Promise<StoredAuthSession | null> {
  const rows = await store.configEntry.findMany({
    where: {
      key: {
        in: [LOCAL_SESSION_TOKEN_KEY, AUTH_USER_KEY, LEGACY_AUTH_TOKEN_KEY],
      },
    },
  });

  const token =
    rows.find((row) => row.key === LOCAL_SESSION_TOKEN_KEY)?.value?.trim() ||
    rows.find((row) => row.key === LEGACY_AUTH_TOKEN_KEY)?.value?.trim();
  const user = parseCachedAuthUser(rows.find((row) => row.key === AUTH_USER_KEY)?.value);

  if (!token || !user) {
    return null;
  }

  return { token, user };
}

export async function getCachedAuthUserForToken(
  token: string,
  store: ConfigStore = prisma,
): Promise<CachedAuthUser | null> {
  const session = await readStoredAuthSession(store);
  if (!session || session.token !== token) {
    return null;
  }

  return session.user;
}

export async function storeAuthSession(
  input: { token: string; user: CachedAuthUser },
  store: ConfigStore = prisma,
) {
  const normalizedToken = input.token.trim();
  if (!normalizedToken) {
    return;
  }

  const userValue = JSON.stringify({
    id: input.user.id,
    code: input.user.code,
    email: input.user.email?.trim() || undefined,
    role: input.user.role,
  });

  await Promise.all([
    store.configEntry.upsert({
      where: { key: LOCAL_SESSION_TOKEN_KEY },
      create: {
        key: LOCAL_SESSION_TOKEN_KEY,
        value: normalizedToken,
      },
      update: {
        value: normalizedToken,
      },
    }),
    store.configEntry.upsert({
      where: { key: AUTH_USER_KEY },
      create: {
        key: AUTH_USER_KEY,
        value: userValue,
      },
      update: {
        value: userValue,
      },
    }),
  ]);
}

export async function clearStoredAuthSession(store: ConfigStore = prisma) {
  await store.configEntry.deleteMany({
    where: {
      key: {
        in: [LOCAL_SESSION_TOKEN_KEY, AUTH_USER_KEY, LEGACY_AUTH_TOKEN_KEY],
      },
    },
  });
}
