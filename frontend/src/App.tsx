import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RoomProvider } from './hooks/useRoomSession';
import { HomePage } from './pages/HomePage';
import { RoomPage } from './pages/RoomPage';
import { AboutPage, NotFoundPage, PrivacyPage, TermsPage } from './pages/StaticPages';

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <RoomProvider>
          <Layout>
            <ErrorBoundary>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/room/:roomId" element={<RoomPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </ErrorBoundary>
          </Layout>
        </RoomProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
