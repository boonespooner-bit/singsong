import { useState, useEffect, useRef } from 'react';
import { useAuth } from './AuthContext';

const GOOGLE_CLIENT_ID = '214965469628-3ijidrc12jl600m8d13nk73k8502fvvr.apps.googleusercontent.com';

export function LoginPage() {
  const { loginWithGoogle, loginWithEmail, register, enterDemo } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      const google = (window as any).google;
      if (!google) return;
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response: any) => {
          setBusy(true);
          setError('');
          try {
            await loginWithGoogle(response.credential);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        },
      });
      if (googleBtnRef.current) {
        google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'filled_black',
          size: 'large',
          width: 320,
          text: 'signin_with',
        });
      }
    };
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
    };
  }, [loginWithGoogle]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'register') {
        await register(email, password, name);
      } else {
        await loginWithEmail(email, password);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
        padding: 24,
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          borderRadius: 16,
          padding: 40,
          width: '100%',
          maxWidth: 400,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>{'\u{1F3B5}'}</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>SingSong</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            Multitrack recording & AI instrument transformation
          </p>
        </div>

        {/* Google Sign-In */}
        <div
          ref={googleBtnRef}
          style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '20px 0',
            color: 'var(--text-muted)',
            fontSize: 12,
          }}
        >
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span>or {mode === 'login' ? 'sign in' : 'sign up'} with email</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <form onSubmit={handleSubmit}>
          {mode === 'register' && (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={inputStyle}
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            style={inputStyle}
          />

          {error && (
            <div
              style={{
                color: 'var(--error)',
                fontSize: 13,
                marginBottom: 12,
                padding: '8px 12px',
                background: '#f4433620',
                borderRadius: 8,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              width: '100%',
              padding: '12px 0',
              background: 'var(--accent)',
              color: '#000',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 15,
              marginBottom: 12,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
          {mode === 'login' ? (
            <>
              Don't have an account?{' '}
              <button
                onClick={() => { setMode('register'); setError(''); }}
                style={{ background: 'none', color: 'var(--accent)', fontWeight: 600, padding: 0 }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => { setMode('login'); setError(''); }}
                style={{ background: 'none', color: 'var(--accent)', fontWeight: 600, padding: 0 }}
              >
                Sign in
              </button>
            </>
          )}
        </div>

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <button
            onClick={enterDemo}
            style={{
              background: 'none',
              color: 'var(--text-muted)',
              fontSize: 13,
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Try demo without an account
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 15,
  marginBottom: 12,
  outline: 'none',
};
