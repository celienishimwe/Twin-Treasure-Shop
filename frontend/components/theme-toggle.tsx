'use client';

import { useLanguage } from '@/components/language';

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme, t } = useLanguage();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      className={`theme-toggle ${className}`.trim()}
      type="button"
      onClick={toggleTheme}
      aria-label={t(nextTheme === 'light' ? 'Switch to light mode' : 'Switch to dark mode')}
      title={t(nextTheme === 'light' ? 'Switch to light mode' : 'Switch to dark mode')}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
      {t(theme === 'dark' ? 'Dark mode' : 'Light mode')}
    </button>
  );
}
