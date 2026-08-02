import bcrypt from 'bcryptjs';
import { NextFunction, Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';
import { getPosUpstreamUrl, isLocalPosBackendMode } from '../localMode';
import { ensureSeedData } from '../seed';
import {
  readStoredSyncAuth,
  storeStoredSyncAuth,
} from '../services/syncCredentials';
import {
  clearStoredAuthSession,
  getCachedAuthUserForToken,
  storeAuthSession,
} from '../services/authCache';

const router = Router();
const AUTH_SECRET =
  process.env.POS_AUTH_SECRET?.trim() ||
  process.env.JWT_SECRET?.trim() ||
  'jingles-pos-local-auth-secret';

type AuthPayload = {
  id: string;
  code: string;
  email?: string | null;
  role: string;
};

type AuthenticatedRequest = Request & {
  user?: AuthPayload;
};

type LocalAuthUser = {
  id: string;
  code: string;
  email: string | null;
  name: string;
  initials: string;
  role: string;
  pin: string | null;
  passwordHash: string | null;
};

type UpstreamAuthPayload = {
  token: string;
  id: string;
  email: string;
  role: string;
};

type UpstreamLoginResult =
  | { ok: true; user: UpstreamAuthPayload }
  | { ok: false; status: number; error: string };

function mapAuthUser(user: LocalAuthUser) {
  return {
    id: user.id,
    code: user.code,
    email: user.email ?? undefined,
    name: user.name,
    initials: user.initials,
    role: user.role,
  };
}

function mapStoredAuthUser(user: Pick<LocalAuthUser, 'id' | 'code' | 'email' | 'role'>): AuthPayload {
  return {
    id: user.id,
    code: user.code,
    email: user.email ?? undefined,
    role: user.role,
  };
}

async function findUserByIdentifier(identifier: string) {
  const normalized = identifier.trim();
  if (!normalized) {
    return null;
  }

  return prisma.pOSUser.findFirst({
    where: {
      OR: [
        { code: normalized.toUpperCase() },
        { email: normalized.toLowerCase() },
      ],
    },
  });
}

function signToken(user: Pick<LocalAuthUser, 'id' | 'code' | 'email' | 'role'>) {
  return jwt.sign(
    {
      id: user.id,
      code: user.code,
      email: user.email,
      role: user.role,
    },
    AUTH_SECRET,
    { expiresIn: '7d' },
  );
}

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }

  const token = header.slice(7);

  try {
    req.user = jwt.verify(token, AUTH_SECRET) as AuthPayload;
    next();
  } catch {
    if (isLocalPosBackendMode()) {
      const cachedUser = await getCachedAuthUserForToken(token);
      if (cachedUser) {
        req.user = {
          id: cachedUser.id,
          code: cachedUser.code,
          email: cachedUser.email ?? undefined,
          role: cachedUser.role,
        };
        next();
        return;
      }
    }

    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function isSupportedPosRole(role: string | null | undefined) {
  return role === 'CASHIER' || role === 'MANAGER';
}

function buildUnsupportedRoleError(role: string | null | undefined) {
  const normalizedRole = role?.trim().toUpperCase() || 'UNKNOWN';
  return `This account is marked as ${normalizedRole}. Only cashier and manager accounts can sign in to the POS workstation.`;
}

function buildUnknownWorkstationUserError() {
  return 'Employee account was not recognised for this workstation. If this is the first sign-in on this device, use the inventory email address instead of the employee code.';
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function looksLikeLocalPlaceholderEmail(value: string | null | undefined) {
  return typeof value === 'string' && value.trim().toLowerCase().endsWith('@jingles.local');
}

function parseUpstreamAuthPayload(payload: unknown): UpstreamAuthPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate =
    'data' in payload && payload.data && typeof payload.data === 'object'
      ? payload.data
      : payload;

  if (!candidate || typeof candidate !== 'object' || !('user' in candidate)) {
    return null;
  }

  const token = 'token' in candidate ? candidate.token : null;
  const user = candidate.user;
  if (!user || typeof user !== 'object') {
    return null;
  }

  const id = 'id' in user ? user.id : null;
  const email = 'email' in user ? user.email : null;
  const role = 'role' in user ? user.role : null;

  if (
    typeof token !== 'string' ||
    typeof id !== 'string' ||
    typeof email !== 'string' ||
    typeof role !== 'string'
  ) {
    return null;
  }

  return {
    token: token.trim(),
    id,
    email: email.toLowerCase(),
    role,
  };
}

function readUpstreamAuthError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const directError =
    'error' in payload && typeof payload.error === 'string' ? payload.error.trim() : '';
  if (directError) {
    return directError;
  }

  const directMessage =
    'message' in payload && typeof payload.message === 'string' ? payload.message.trim() : '';
  if (directMessage) {
    return directMessage;
  }

  const nestedData =
    'data' in payload && payload.data && typeof payload.data === 'object'
      ? payload.data
      : null;

  if (nestedData) {
    const nestedError =
      'error' in nestedData && typeof nestedData.error === 'string'
        ? nestedData.error.trim()
        : '';
    if (nestedError) {
      return nestedError;
    }

    const nestedMessage =
      'message' in nestedData && typeof nestedData.message === 'string'
        ? nestedData.message.trim()
        : '';
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  return fallback;
}

function mapInventoryRoleToPosRole(role: string) {
  switch (role.trim().toUpperCase()) {
    case 'ADMIN':
    case 'MANAGER':
      return 'MANAGER';
    case 'STAFF':
    case 'INSPECTOR':
    case 'CASHIER':
      return 'CASHIER';
    case 'SALESPERSON':
      return 'SALESPERSON';
    default:
      return null;
  }
}

function deriveDisplayName(email: string, fallback?: string | null) {
  const normalizedFallback = fallback?.trim();
  if (normalizedFallback) {
    return normalizedFallback;
  }

  const localPart = email.split('@')[0] ?? '';
  const words = localPart
    .split(/[._-]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token[0]!.toUpperCase() + token.slice(1).toLowerCase());

  return words.length > 0 ? words.join(' ') : 'POS User';
}

function deriveInitials(name: string, fallback?: string | null) {
  const normalizedFallback = fallback?.trim();
  if (normalizedFallback) {
    return normalizedFallback.toUpperCase().slice(0, 3);
  }

  const tokens = name
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return 'PU';
  }

  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 2).toUpperCase();
  }

  return `${tokens[0]![0] ?? ''}${tokens[1]![0] ?? ''}`.toUpperCase();
}

function deriveCode(id: string, email: string, fallback?: string | null) {
  const normalizedFallback = fallback?.trim();
  if (normalizedFallback) {
    return normalizedFallback.toUpperCase();
  }

  const emailCode = email
    .split('@')[0]
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 10);
  if (emailCode) {
    return emailCode;
  }

  const suffix = id.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase();
  return `INV${suffix || 'USER'}`;
}

async function requestUpstreamLogin(
  identifier: string,
  password: string,
  existingUser: LocalAuthUser | null,
): Promise<UpstreamLoginResult | null> {
  if (!isLocalPosBackendMode()) {
    return null;
  }

  const email = looksLikeEmail(identifier)
    ? identifier.trim().toLowerCase()
    : existingUser?.email?.trim().toLowerCase() ?? '';

  if (!email || looksLikeLocalPlaceholderEmail(email)) {
    return {
      ok: false,
      status: 400,
      error: 'Use the real inventory email address for workstation sync and first-time hosted sign-in.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`${getPosUpstreamUrl()}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status === 401 || response.status === 403 ? 401 : Math.max(response.status, 400),
        error: readUpstreamAuthError(
          payload,
          response.status >= 500
            ? 'The shared inventory backend is unavailable right now.'
            : 'Inventory credentials were rejected.',
        ),
      };
    }

    const user = parseUpstreamAuthPayload(payload);
    if (!user) {
      return {
        ok: false,
        status: 502,
        error: 'The shared inventory backend returned an invalid auth payload.',
      };
    }

    return {
      ok: true,
      user,
    };
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'Unable to reach the shared inventory backend to verify this account.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function upsertInventoryBackedUser(
  upstreamUser: UpstreamAuthPayload,
  password: string,
  existingUser: LocalAuthUser | null,
) {
  const mappedRole = mapInventoryRoleToPosRole(upstreamUser.role);
  if (!isSupportedPosRole(mappedRole)) {
    return null;
  }

  const lookupUser = existingUser ?? await prisma.pOSUser.findFirst({
    where: {
      OR: [
        { id: upstreamUser.id },
        { email: upstreamUser.email },
      ],
    },
  });

  const name = deriveDisplayName(upstreamUser.email, lookupUser?.name);
  const initials = deriveInitials(name, lookupUser?.initials);
  const passwordHash = await bcrypt.hash(password, 10);

  if (lookupUser) {
    return prisma.pOSUser.update({
      where: { id: lookupUser.id },
      data: {
        email: upstreamUser.email,
        name,
        initials,
        role: mappedRole,
        passwordHash,
      },
    });
  }

  return prisma.pOSUser.create({
    data: {
      id: upstreamUser.id,
      code: deriveCode(upstreamUser.id, upstreamUser.email),
      email: upstreamUser.email,
      name,
      initials,
      role: mappedRole,
      passwordHash,
    },
  });
}

async function tryLocalPasswordLogin(user: LocalAuthUser, password: string) {
  if (isSupportedPosRole(user.role) && user.passwordHash) {
    return bcrypt.compare(password, user.passwordHash);
  }

  return false;
}

async function rememberSyncAuthForUser(
  upstreamUser: UpstreamAuthPayload,
) {
  await storeStoredSyncAuth({
    token: upstreamUser.token,
    identity: upstreamUser.email,
  });
}

async function resolveSyncIdentityInput(
  identifier: string,
): Promise<{ identifier: string; localUser: LocalAuthUser | null } | null> {
  const requestedIdentifier = identifier.trim();
  if (requestedIdentifier) {
    return {
      identifier: requestedIdentifier,
      localUser: await findUserByIdentifier(requestedIdentifier),
    };
  }

  const storedSyncAuth = await readStoredSyncAuth();
  if (storedSyncAuth?.identity?.trim()) {
    return {
      identifier: storedSyncAuth.identity.trim(),
      localUser: await findUserByIdentifier(storedSyncAuth.identity.trim()),
    };
  }

  return null;
}

async function issueLocalSession(user: LocalAuthUser) {
  const token = signToken(user);
  await storeAuthSession({
    token,
    user: mapStoredAuthUser(user),
  });

  return {
    token,
    user: mapAuthUser(user),
  };
}

router.post('/login', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const identifier = typeof req.body.identifier === 'string' ? req.body.identifier : '';
    const password = typeof req.body.password === 'string' ? req.body.password.trim() : '';

    if (!identifier.trim() || !password) {
      return res.status(400).json({ error: 'Identifier and password are required' });
    }

    const user = await findUserByIdentifier(identifier);
    if (user && isSupportedPosRole(user.role) && await tryLocalPasswordLogin(user, password)) {
      const upstreamLogin = await requestUpstreamLogin(identifier, password, user);
      if (upstreamLogin?.ok) {
        const syncedUser = await upsertInventoryBackedUser(upstreamLogin.user, password, user);
        if (syncedUser) {
          await rememberSyncAuthForUser(upstreamLogin.user);
          return res.json(await issueLocalSession(syncedUser));
        }
      }

      return res.json(await issueLocalSession(user));
    }

    if (user && isSupportedPosRole(user.role) && user.pin === password) {
      if (!user.passwordHash) {
        await prisma.pOSUser.update({
          where: { id: user.id },
          data: {
            passwordHash: await bcrypt.hash(password, 10),
          },
        });
      }

      const refreshedUser = await prisma.pOSUser.findUnique({ where: { id: user.id } });
      if (!refreshedUser) {
        return res.status(500).json({ error: 'POS login failed' });
      }

      return res.json(await issueLocalSession(refreshedUser));
    }

    if (user && !isSupportedPosRole(user.role)) {
      return res.status(401).json({ error: buildUnsupportedRoleError(user.role) });
    }

    const upstreamLogin = await requestUpstreamLogin(identifier, password, user);
    if (upstreamLogin?.ok) {
      const syncedUser = await upsertInventoryBackedUser(upstreamLogin.user, password, user);
      if (!syncedUser) {
        return res.status(403).json({ error: 'This inventory account does not have POS access.' });
      }

      await rememberSyncAuthForUser(upstreamLogin.user);

      return res.json(await issueLocalSession(syncedUser));
    }

    if (upstreamLogin && upstreamLogin.status >= 500) {
      return res.status(upstreamLogin.status).json({ error: upstreamLogin.error });
    }

    if (user && isSupportedPosRole(user.role)) {
      return res.status(401).json({
        error: upstreamLogin?.error ?? 'Password does not match the selected employee.',
      });
    }

    if (upstreamLogin) {
      return res.status(upstreamLogin.status).json({ error: upstreamLogin.error });
    }

    return res.status(401).json({ error: buildUnknownWorkstationUserError() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'POS login failed' });
  }
});

router.post('/sync-token', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureSeedData();

    if (!isLocalPosBackendMode()) {
      return res.status(400).json({ error: 'Sync auth exchange is only available in desktop local mode.' });
    }

    const password = typeof req.body.password === 'string' ? req.body.password.trim() : '';
    const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim() : '';
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const user = await prisma.pOSUser.findUnique({
      where: { id: req.user!.id },
    });
    if (!user) {
      return res.status(404).json({ error: 'Authenticated user no longer exists' });
    }

    const syncIdentityInput = await resolveSyncIdentityInput(identifier);
    if (!syncIdentityInput) {
      return res.status(400).json({
        error: 'Enter the workstation host account before reconnecting sync.',
      });
    }

    const upstreamLogin = await requestUpstreamLogin(
      syncIdentityInput.identifier,
      password,
      syncIdentityInput.localUser,
    );
    if (!upstreamLogin?.ok) {
      return res.status(upstreamLogin?.status ?? 503).json({
        error: upstreamLogin?.error ?? 'Unable to refresh host sync authentication.',
      });
    }

    await rememberSyncAuthForUser(upstreamLogin.user);

    return res.json({
      syncAuthConfigured: true,
      syncAuthIdentity: upstreamLogin.user.email,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to refresh host sync authentication' });
  }
});

router.get('/me', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureSeedData();
    const user = await prisma.pOSUser.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      return res.status(404).json({ error: 'Authenticated user no longer exists' });
    }

    return res.json(mapAuthUser(user));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load the authenticated POS user' });
  }
});

router.post('/logout', async (_req: Request, res: Response) => {
  await clearStoredAuthSession();
  res.json({ ok: true });
});

export default router;
