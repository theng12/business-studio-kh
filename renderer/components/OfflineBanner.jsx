/**
 * 0.1.94 connectivity pass: the "server Mac is gone" banner.
 *
 * Client mode only. Until this existed the only sign that the server had gone
 * away was a 7px dot turning red in the sidebar footer (hidden entirely when
 * the sidebar is collapsed), so people kept editing into a connection that
 * could not save anything and found out from a pile of error toasts.
 *
 * Shown while main reports `disconnected` (main already debounces a single
 * missed ping, so this does not flicker on a blip). Main keeps retrying by
 * itself; Retry asks for a real check right now — a ping plus a reconnect of
 * the live-update socket (`client:reconnectNow`) — and says what it found.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/index.js';
import { Button } from './ui.jsx';

export function OfflineBanner() {
  const appMode = useAppStore((s) => s.appMode);
  const status = useAppStore((s) => s.clientConnection?.status);
  const lastError = useAppStore((s) => s.clientConnection?.lastError);
  const addToast = useAppStore((s) => s.addToast);
  const [checking, setChecking] = useState(false);
  const [stillDown, setStillDown] = useState(false);
  // A new outage starts with a clean message.
  useEffect(() => { if (status !== 'disconnected') setStillDown(false); }, [status]);

  if (appMode !== 'client' || status !== 'disconnected') return null;

  async function retry() {
    if (checking) return;
    setChecking(true);
    setStillDown(false);
    try {
      const next = await window.api?.client?.reconnectNow?.();
      if (next) useAppStore.setState({ clientConnection: next });
      if (next?.status === 'connected') addToast?.('Connected to the server Mac again.', 'success');
      else setStillDown(true);
    } catch (err) {
      setStillDown(true);
      addToast?.(err.message, 'error');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-banner__dot" aria-hidden="true" />
      <div className="offline-banner__body">
        <strong>Can&rsquo;t reach the server Mac &mdash; reconnecting&hellip;</strong>
        <span>
          Edits won&rsquo;t save until it&rsquo;s back.
          {stillDown ? ' Still no answer — check the server Mac is awake and on Tailscale.' : ''}
        </span>
        {lastError ? <span className="offline-banner__detail" title={lastError}>{lastError}</span> : null}
      </div>
      <Button onClick={retry} disabled={checking}>{checking ? 'Checking…' : 'Retry'}</Button>
    </div>
  );
}
