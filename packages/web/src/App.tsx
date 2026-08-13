import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import CustomerDisplayPage from './pages/CustomerDisplayPage';
import LoginPage from './pages/LoginPage';
import SyncPage from './pages/SyncPage';
import PosWorkstation from './posWorkstation';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Deliberately outside ProtectedRoute: the customer screen shows only
          what the workstation pushes to it and never reaches the API itself. */}
      <Route path="/customer-display" element={<CustomerDisplayPage />} />
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
