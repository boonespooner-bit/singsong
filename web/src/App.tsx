import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { Home } from './pages/Home';
import { SongEditor } from './pages/SongEditor';
import './App.css';

function AppRoutes() {
  const { user, loading, isDemo } = useAuth();

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: '#888',
      }}>
        Loading...
      </div>
    );
  }

  if (!user && !isDemo) {
    return <LoginPage />;
  }

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/song/:id" element={<SongEditor />} />
      </Routes>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
