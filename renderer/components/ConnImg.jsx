/**
 * 0.1.94 connectivity pass: an `<img>` that heals after a reconnect.
 *
 * WHY. On a client Mac every picture is fetched from the server Mac through
 * `app-image://`. When the server is unreachable that request fails (now
 * after 20s at most, see main/protocol.js), the browser marks the `<img>` as
 * broken, and nothing ever asks again: the audit reproduced a Library page of
 * 12 broken thumbnails that stayed broken after the connection came back,
 * until the user navigated away and back.
 *
 * WHAT IT DOES. Exactly what `<img>` does, plus: if the image fails while this
 * Mac is in client mode, it waits for the connection to recover (main bumps
 * `clientConnection.reconnectCount` on every disconnected → connected
 * transition) and then loads the same picture again with `r=<reconnectCount>`
 * appended, so the browser treats it as a fresh request. The server ignores
 * `r`. In standalone / server mode it is a plain `<img>` — a local file that
 * fails to load will not start loading because of a network event.
 *
 * USAGE — a drop-in replacement; every prop is passed through:
 *
 *   import { ConnImg } from '../../components/ConnImg.jsx';
 *   <ConnImg src={appImageSrc(p.mainImagePath, stamp, { w: 320 })} alt="" loading="lazy" />
 *
 * `onError` / `onLoad` still fire (onError once per failed attempt), so an
 * existing placeholder fallback keeps working; render the placeholder while
 * the image is broken and keep the ConnImg mounted (e.g. hidden) if you want
 * the automatic retry — an unmounted image cannot retry.
 */
import { forwardRef, useEffect, useState } from 'react';
import { useAppStore } from '../store/index.js';

/** `src` with `r=<n>` added (or `src` unchanged when n is falsy). Pure. */
export function withRetryParam(src, n) {
  if (!src || !n) return src;
  const hashAt = src.indexOf('#');
  const base = hashAt === -1 ? src : src.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : src.slice(hashAt);
  const cleaned = base.replace(/([?&])r=\d+(&|$)/, (_m, lead, tail) => (tail ? lead : ''));
  const sep = cleaned.includes('?') ? (/[?&]$/.test(cleaned) ? '' : '&') : '?';
  return `${cleaned}${sep}r=${n}${hash}`;
}

/**
 * Decide whether a failed image should be retried now. Pure, for tests.
 * `failedAt` is the reconnectCount when the image failed (null = not failed).
 */
export function shouldRetryImage({ appMode, status, reconnectCount, failedAt }) {
  if (appMode !== 'client' || failedAt == null) return false;
  return status === 'connected' && reconnectCount > failedAt;
}

export const ConnImg = forwardRef(function ConnImg({ src, onError, ...rest }, ref) {
  const appMode = useAppStore((s) => s.appMode);
  const status = useAppStore((s) => s.clientConnection?.status);
  const reconnectCount = useAppStore((s) => s.clientConnection?.reconnectCount ?? 0);
  // { src, failedAt } — scoped to the src it belongs to, so a new src starts clean.
  const [failure, setFailure] = useState(null);
  const [retry, setRetry] = useState(null); // { src, tag }

  const failedAt = failure && failure.src === src ? failure.failedAt : null;
  useEffect(() => {
    if (shouldRetryImage({ appMode, status, reconnectCount, failedAt })) {
      setRetry({ src, tag: reconnectCount });
      setFailure(null);
    }
  }, [appMode, status, reconnectCount, failedAt, src]);

  const shown = retry && retry.src === src ? withRetryParam(src, retry.tag) : src;

  function handleError(event) {
    if (appMode === 'client') setFailure({ src, failedAt: reconnectCount });
    onError?.(event);
  }

  return <img ref={ref} {...rest} src={shown} onError={handleError} />;
});
