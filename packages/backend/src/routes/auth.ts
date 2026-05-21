import { NextFunction, Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';
import { ensureSeedData } from '../seed';

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

function mapAuthUser(user: {
  id: string;
  code: string;
  email: string | null;
  name: string;
  initials: string;
  role: string;
}) {
  return {
    id: user.id,
    code: user.code,
    email: user.email ?? undefined,
    name: user.name,
    initials: user.initials,
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

function signToken(user: { id: string; code: string; email: string | null; role: string }) {
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

function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }

  try {
    req.user = jwt.verify(header.slice(7), AUTH_SECRET) as AuthPayload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

router.post('/login', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const identifier = typeof req.body.identifier === 'string' ? req.body.identifier : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!identifier.trim() || !password.trim()) {
      return res.status(400).json({ error: 'Identifier and password are required' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user || (user.role !== 'CASHIER' && user.role !== 'MANAGER')) {
      return res.status(401).json({ error: 'Employee account was not recognised for this workstation.' });
    }

    if (!user.pin || user.pin !== password.trim()) {
      return res.status(401).json({ error: 'Password does not match the selected employee.' });
    }

    return res.json({
      token: signToken(user),
      user: mapAuthUser(user),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'POS login failed' });
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

router.post('/logout', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export default router;
