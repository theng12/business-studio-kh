import { useAppStore } from '../store/index.js';

export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.variant}${t.action ? ' toast--has-action' : ''}`}
          onClick={() => dismiss(t.id)}
          role="alert"
        >
          <span className="toast__message">{t.message}</span>
          {/* 0.1.94: one optional action (e.g. Undo) on the same line. */}
          {t.action ? (
            <button
              type="button"
              className="toast__action"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                t.action.onClick();
              }}
            >{t.action.label}</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
