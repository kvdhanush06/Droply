import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes anywhere below the layout and shows a
 * recoverable error card instead of a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Renderer errors are surfaced to the user; the detail stays in the console.
    console.error('Droply crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <section className="card" role="alert" style={{ borderColor: 'var(--danger)' }}>
          <h1>Something went wrong</h1>
          <p>An unexpected error interrupted Droply. Reloading the page usually fixes it.</p>
          <p className="hint" style={{ wordBreak: 'break-all' }}>
            {this.state.error.message}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload Droply
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
