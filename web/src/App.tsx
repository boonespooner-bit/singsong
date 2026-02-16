import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { SongEditor } from './pages/SongEditor';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/song/:id" element={<SongEditor />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
