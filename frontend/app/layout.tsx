import './globals.css';
import type { Metadata } from 'next';
import AuthShell from '@/components/auth-shell';

export const metadata: Metadata = {
  title: 'Twin Treasure Shop Management',
  description: 'Business investment and profit management system'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthShell>{children}</AuthShell>
      </body>
    </html>
  );
}
