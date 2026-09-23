import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="app-header">
        <div className="container app-header-inner">
          <Link to="/" className="brand" aria-label="Droply home">
            <Logo />
            Droply
          </Link>
          <div className="header-actions">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" className="app-main">
        <div className="container">{children}</div>
      </main>
      <footer className="app-footer">
        <div className="container app-footer-inner">
          <span>Files travel directly between your devices — nothing is uploaded to a server.</span>
          <nav aria-label="Footer">
            <Link to="/about">About</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
