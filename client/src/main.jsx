import React from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import CustomerAvailability from './CustomerAvailability.jsx';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    console.error('React Crash:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', background: '#ffebe9', color: '#cf222e', fontFamily: 'monospace', height: '100vh', overflow: 'auto' }}>
          <h2>Application Crashed!</h2>
          <details style={{ whiteSpace: 'pre-wrap' }}>
            <summary>Click to view error details</summary>
            {this.state.error && this.state.error.toString()}
            <br />
            {this.state.errorInfo && this.state.errorInfo.componentStack}
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Simple URL routing ─────────────────────────────────────────────────────
// If URL contains ?id=KARUR001  →  render Customer Availability page
// Otherwise                     →  render main SmartParcel App
const urlParams   = new URLSearchParams(window.location.search);
const isAvailPage = window.location.pathname.includes('/available') || urlParams.has('id');
const customerId  = urlParams.get('id');
// ──────────────────────────────────────────────────────────────────────────

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      {isAvailPage && customerId
        ? <CustomerAvailability customerId={customerId} />
        : <App />
      }
    </ErrorBoundary>
  </StrictMode>,
);
