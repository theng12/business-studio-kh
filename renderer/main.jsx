import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { KioskApp } from './modules/Kiosk/index.jsx';
import './index.css';

// HR1: the shop Mac's attendance kiosk window loads index.html#kiosk
// (main/kioskWindow.js) and shows ONLY the kiosk screen — no sidebar, no Home.
const isKioskWindow = window.location.hash === '#kiosk';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isKioskWindow ? <KioskApp /> : <App />}
  </React.StrictMode>,
);
