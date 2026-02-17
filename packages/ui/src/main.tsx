import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SourceVersionProvider } from './contexts/SourceVersionContext';
import './App.css';
import './services/tauri-bridge'; // Initialize Tauri bridge and polyfills

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SourceVersionProvider>
      <App />
    </SourceVersionProvider>
  </React.StrictMode>
);
