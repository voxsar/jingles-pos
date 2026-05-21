import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export default function ProtectedRoute({ children }: { children: ReactElement }) {
  const { isLoading, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="screen-fill workstation-app">
        <div className="bg-layer bg-layer-grid" />
        <div className="state-card glass-panel">
          <div className="state-title">Restoring local session...</div>
          <p className="state-copy">Checking the workstation auth cache.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
