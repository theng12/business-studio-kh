import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { KioskApp } from './modules/Kiosk/index.jsx';
import { KioskErrorBoundary } from './modules/Kiosk/KioskErrorBoundary.jsx';
import './index.css';

// HR1: the shop Mac's attendance kiosk window (main/kioskWindow.js) shows ONLY
// the kiosk screen — no sidebar, no Home. Main tells the window what it is
// (preload flag from additionalArguments), not the URL: a changed hash can
// never mount the full app inside the locked window.
const isKioskWindow = window.api?.kioskMode?.isKioskWindow === true;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isKioskWindow ? <KioskErrorBoundary><KioskApp /></KioskErrorBoundary> : <App />}
  </React.StrictMode>,
);
