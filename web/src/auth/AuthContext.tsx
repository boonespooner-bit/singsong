import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

export interface User {
  id: number;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  isDemo: boolean;
}

interface AuthContextValue extends AuthState {
  loginWithGoogle: (credential: string) => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  enterDemo: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = 'singsong_token';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, isDemo: false });

  const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  const loadUser = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setState({ user: null, loading: false, isDemo: false });
      return;
    }
    try {
      const r = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const { user } = await r.json();
        setState({ user, loading: false, isDemo: false });
      } else {
        clearToken();
        setState({ user: null, loading: false, isDemo: false });
      }
    } catch {
      setState({ user: null, loading: false, isDemo: false });
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  const loginWithGoogle = async (credential: string) => {
    const r = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (!r.ok) {
      const { error } = await r.json();
      throw new Error(error);
    }
    const { token, user } = await r.json();
    setToken(token);
    setState({ user, loading: false, isDemo: false });
  };

  const loginWithEmail = async (email: string, password: string) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      const { error } = await r.json();
      throw new Error(error);
    }
    const { token, user } = await r.json();
    setToken(token);
    setState({ user, loading: false, isDemo: false });
  };

  const register = async (email: string, password: string, name: string) => {
    const r = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    if (!r.ok) {
      const { error } = await r.json();
      throw new Error(error);
    }
    const { token, user } = await r.json();
    setToken(token);
    setState({ user, loading: false, isDemo: false });
  };

  const enterDemo = () => {
    setState({ user: null, loading: false, isDemo: true });
  };

  const logout = () => {
    clearToken();
    setState({ user: null, loading: false, isDemo: false });
  };

  return (
    <AuthContext.Provider
      value={{ ...state, loginWithGoogle, loginWithEmail, register, enterDemo, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
