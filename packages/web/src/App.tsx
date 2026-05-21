import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import SyncPage from './pages/SyncPage';
import PosWorkstation from './posWorkstation';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/sync"
        element={(
          <ProtectedRoute>
            <SyncPage />
          </ProtectedRoute>
        )}
      />
      <Route
        path="/"
        element={(
          <ProtectedRoute>
            <PosWorkstation />
          </ProtectedRoute>
        )}
      />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}
