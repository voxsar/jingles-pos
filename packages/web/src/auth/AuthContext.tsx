import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { POSUser } from '@jingles/shared';
import {
  getCurrentUser,
  login as requestLogin,
  logout as requestLogout,
} from '../api';

const TOKEN_STORAGE_KEY = 'jingles-pos-auth-token';
const LAST_ACTIVITY_STORAGE_KEY = 'jingles-pos-last-activity-at';

type AuthContextValue = {
  user: POSUser | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<POSUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!storedToken) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    void getCurrentUser(storedToken)
      .then((nextUser) => {
        if (cancelled || !nextUser) {
          return;
        }

        setToken(storedToken);
        setUser(nextUser);
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await requestLogin({ identifier, password });
      localStorage.setItem(TOKEN_STORAGE_KEY, result.token);
      localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
      setToken(result.token);
      setUser(result.user);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : 'Login failed';
      setError(message);
      throw nextError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    const currentToken = token ?? localStorage.getItem(TOKEN_STORAGE_KEY);
    if (currentToken) {
      try {
        await requestLogout(currentToken);
      } catch {
        // Clear the local session even if the remote/logout bridge path fails.
      }
    }

    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(LAST_ACTIVITY_STORAGE_KEY);
    setToken(null);
    setUser(null);
    setError(null);
  }, [token]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      error,
      login,
      logout,
      clearError,
    }),
    [clearError, error, isLoading, login, logout, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return value;
}
