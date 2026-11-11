'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Sidebar from '@/components/sidebar';
import { LanguagePicker, LanguageProvider, useLanguage } from '@/components/language';
import { ToastNotifications, useToastNotifications } from '@/components/notifications';
import ThemeToggle from '@/components/theme-toggle';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

type AuthStatus = {
  setupRequired: boolean;
  user: { id: number; email: string } | null;
};

export default function AuthShell({ children }: { children: React.ReactNode }) {
  return <LanguageProvider><AuthContent>{children}</AuthContent></LanguageProvider>;
}

function AuthContent({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useToastNotifications(notice, error);

  const refreshStatus = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/auth/status`, { credentials: 'include', cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(t(body.error ?? 'Unable to check authentication.'));
      setStatus(body);
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t('Unable to connect to the backend.'));
      setStatus(null);
    }
  }, [t]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const endpoint = status?.setupRequired ? 'setup' : 'login';
      const response = await fetch(`${API_URL}/api/auth/${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(t(body.error ?? 'Authentication failed.'));
      await refreshStatus();
      setPassword('');
      setNotice(t('Signed in successfully.'));
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t('Authentication failed.'));
    } finally {
      setSubmitting(false);
    }
  }

  const logout = async () => {
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error(t('Unable to sign out.'));
      await refreshStatus();
      setNotice(t('Signed out successfully.'));
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t('Unable to sign out.'));
    }
  };

  if (!status) {
    return (
      <>
      <ToastNotifications />
      <main className="auth-page">
        <ThemeToggle className="auth-theme-toggle" />
        <section className="auth-card">
          <LanguagePicker className="auth-language-picker" />
          <div className="brand-mark auth-brand-mark">TT</div>
          <p className="eyebrow">{t('Twin Treasure · Secure access')}</p>
          <h1>{t(error ? 'Connection needed' : 'Checking your session')}</h1>
          <p className="auth-description">{error || t('Please wait while we check your sign-in.')}</p>
          {error && <button className="primary-button auth-submit" type="button" onClick={() => void refreshStatus()}>{t('Retry connection')}</button>}
        </section>
      </main>
      </>
    );
  }

  if (!status.user) {
    const firstSetup = status.setupRequired;
    return (
      <>
      <ToastNotifications />
      <main className="auth-page">
        <ThemeToggle className="auth-theme-toggle" />
        <section className="auth-card">
          <LanguagePicker className="auth-language-picker" />
          <div className="brand-mark auth-brand-mark">TT</div>
          <p className="eyebrow">{t(firstSetup ? 'First-time setup' : 'Twin Treasure · Secure access')}</p>
          <h1>{t(firstSetup ? 'Create your owner account' : 'Welcome back')}</h1>
          <p className="auth-description">
            {firstSetup
              ? t('Set up the private owner account. New registrations are disabled once this account is created.')
              : t('Sign in to manage your shop and financial records.')}
          </p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <form onSubmit={handleSubmit} className="auth-form">
            <label>
              <span>{t('Email address')}</span>
              <input type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label>
              <span>{t('Password')}</span>
              <input type="password" autoComplete={firstSetup ? 'new-password' : 'current-password'} required minLength={firstSetup ? 10 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
              {firstSetup && <small>{t('Use at least 10 characters.')}</small>}
            </label>
            <button className="primary-button auth-submit" type="submit" disabled={submitting}>
              {submitting ? t('Please wait…') : t(firstSetup ? 'Create owner account' : 'Sign in')}
            </button>
          </form>
          <p className="auth-footnote">{t('Your password is securely hashed and your session is stored in a protected HTTP-only cookie.')}</p>
        </section>
      </main>
      </>
    );
  }

  return (
    <>
    <ToastNotifications />
    <div className="app-shell">
      <Sidebar userEmail={status.user.email} onLogout={() => void logout()} />
      <main className="content">{children}</main>
    </div>
    </>
  );
}
