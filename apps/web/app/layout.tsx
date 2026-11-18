import type { ReactNode } from 'react';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata = { title: 'PaperWeave' };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
