'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type SidebarProps = {
  userEmail: string;
  onLogout: () => void;
};

const navigation = [
  { href: '/', label: 'Dashboard', icon: '▦' },
  { href: '/money', label: 'Money Management', icon: '◉' },
  { href: '/products', label: 'Product Management', icon: '▣' },
  { href: '/investments', label: 'Product Investment', icon: '＋' },
  { href: '/transactions', label: 'Transaction History', icon: '≡' },
  { href: '/reports', label: 'Daily & Monthly Reports', icon: '◷' }
];

export default function Sidebar({ userEmail, onLogout }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link href="/" className="brand-block">
        <div className="brand-mark">TT</div>
        <div className="brand-copy">
          <strong>Twin Treasure</strong>
          <span>SHOP MANAGEMENT</span>
        </div>
      </Link>

      <div className="sidebar-section-label">WORKSPACE</div>
      <nav className="nav" aria-label="Main navigation">
        {navigation.map((item) => {
          const active = pathname === item.href;
          return (
            <Link key={item.href} href={item.href} className={`nav-link${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              {active && <span className="nav-current" aria-hidden="true">›</span>}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <span className="connection-indicator" />
        <div className="sidebar-user"><strong>{userEmail}</strong><small>Owner account</small></div>
        <button className="logout-button" type="button" onClick={onLogout} aria-label="Sign out">↪</button>
      </div>
    </aside>
  );
}
