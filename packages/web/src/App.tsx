import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import POSScreen from './pages/POSScreen';
import SalesHistory from './pages/SalesHistory';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="app-nav">
          <div className="nav-brand">🛒 Jingles POS</div>
          <div className="nav-links">
            <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              POS Terminal
            </NavLink>
            <NavLink to="/sales" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Sales History
            </NavLink>
          </div>
        </nav>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<POSScreen />} />
            <Route path="/sales" element={<SalesHistory />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
