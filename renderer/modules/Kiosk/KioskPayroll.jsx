import { useEffect, useRef, useState } from 'react';
import { classifyError, t } from './kioskLogic.js';
import { currentKioskData, kioskContext, kioskLoanTotal, kioskMoney, kioskPage, kioskPayrollError } from './kioskPayrollModel.js';

/** Private sections of My records. Only kiosk:* derives ownership from the PIN token. */
export function KioskPayroll({ lang, sessionToken, employee, onSessionEnded, isSessionCurrent }) {
  const context = kioskContext(sessionToken, employee);
  const current = useRef(context);
  current.current = context;
  const scopeRef = useRef(null);
  const [data, setData] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [pages, setPages] = useState({ payroll: 1, loans: 1 });
  const [sizes, setSizes] = useState({ payroll: 50, loans: 50 });
  const visible = currentKioskData(data, context);

  const isCurrent = (scope) => scope?.active && current.current === scope.context
    && (!isSessionCurrent || isSessionCurrent(scope.context));

  useEffect(() => {
    if (!context) { setData(null); return undefined; }
    const scope = { context, active: true, saving: false };
    scopeRef.current = scope;
    setPages({ payroll: 1, loans: 1 });
    setSizes({ payroll: 50, loans: 50 });
    const loading = { status: 'loading', items: [], error: null };
    setData({ context, payroll: loading, loans: loading, saveId: null, saveError: null, notice: null });
    const valid = () => scope.active && current.current === context
      && (!isSessionCurrent || isSessionCurrent(context));
    for (const kind of ['payroll', 'loans']) {
      (async () => {
        try {
          const rows = await window.api.kiosk[kind]({ sessionToken });
          if (!valid()) return;
          if (!Array.isArray(rows)) throw new Error('Invalid private records response');
          const items = rows.filter(row => row && (kind === 'payroll'
            ? ['approved', 'paid'].includes(row.status) : ['active', 'paid', 'written_off', 'void'].includes(row.status)));
          setData(d => d?.context === context ? { ...d, [kind]: { status: 'ready', items, error: null } } : d);
        } catch (err) {
          if (!valid()) return;
          if (classifyError(err).kind === 'sessionEnded') {
            scope.active = false; setData(null); onSessionEnded(); return;
          }
          setData(d => d?.context === context ? { ...d, [kind]: { status: 'error', items: [], error: err } } : d);
        }
      })();
    }
    return () => { scope.active = false; scope.saving = false; };
  }, [context, sessionToken, attempt, onSessionEnded, isSessionCurrent]);

  async function download(id) {
    const scope = scopeRef.current;
    if (!isCurrent(scope) || scope.saving || !visible?.payroll.items.some(row => row.id === id)) return;
    scope.saving = true;
    setData(d => ({ ...d, saveId: id, notice: null, saveError: null }));
    try {
      const result = await window.api.kiosk.savePayslipPdf({ sessionToken, id });
      if (!isCurrent(scope)) return;
      // Cancellation is quiet; the local path never appears on the shared kiosk.
      setData(d => ({ ...d, notice: result ? 'payroll_saved' : null }));
    } catch (err) {
      if (!isCurrent(scope)) return;
      if (classifyError(err).kind === 'sessionEnded') {
        scope.active = false; setData(null); onSessionEnded(); return;
      }
      setData(d => ({ ...d, saveError: err }));
    } finally {
      scope.saving = false;
      if (isCurrent(scope)) setData(d => ({ ...d, saveId: null }));
    }
  }

  if (!context) return null;
  const payroll = kioskPage(visible?.payroll.items || [], pages.payroll, sizes.payroll);
  const loans = kioskPage(visible?.loans.items || [], pages.loans, sizes.loans);
  const retry = () => setAttempt(n => n + 1);
  return (
    <>
      <section className="kiosk-card" aria-label={t(lang, 'payroll_title')}>
        <h3 className="kiosk-h3">{t(lang, 'payroll_title')}</h3>
        <p className="kiosk-hint">{t(lang, 'payroll_approved_only')}</p>
        {!visible || visible.payroll.status === 'loading' ? <p role="status">{t(lang, 'loading')}</p> : null}
        {visible?.payroll.error ? <p className="kiosk-message kiosk-message--error" role="alert">{kioskPayrollError(visible.payroll.error, lang)}</p> : null}
        {visible?.payroll.status === 'ready' && !payroll.total ? <p className="kiosk-muted">{t(lang, 'payroll_empty')}</p> : null}
        {payroll.items.map(row => (
          <div key={row.id}>
            <h4 className="kiosk-h3">{row.periodStart}–{row.periodEnd} · {t(lang, `payroll_${row.status}`)}</h4>
            <dl className="kiosk-stats">
              {[['payroll_pay_date', row.payDate], ['payroll_net', kioskMoney(row.netMinor, row.currency)],
                ['payroll_paid_amount', kioskMoney(row.paidMinor, row.currency)], ['payroll_remaining', kioskMoney(row.remainingMinor, row.currency)]].map(([key, value]) => (
                <div key={key} className="kiosk-stats__row"><dt>{t(lang, key)}</dt><dd>{value || '—'}</dd></div>
              ))}
            </dl>
            <div className="kiosk-actions kiosk-actions--start">
              <button type="button" className="kiosk-btn" disabled={!!visible.saveId} onClick={() => download(row.id)}
                aria-label={t(lang, 'payroll_download_period', { from: row.periodStart, to: row.periodEnd })}>
                {visible.saveId === row.id ? t(lang, 'saving') : t(lang, 'payroll_download')}
              </button>
            </div>
          </div>
        ))}
        {visible?.saveError ? <p className="kiosk-message kiosk-message--error" role="alert">{kioskPayrollError(visible.saveError, lang, true)}</p> : null}
        {visible?.notice ? <p className="kiosk-message kiosk-message--ok" role="status">{t(lang, visible.notice)}</p> : null}
        {visible?.payroll.status === 'error' ? <button type="button" className="kiosk-btn" onClick={retry}>{t(lang, 'try_again')}</button> : null}
        <KioskFinancialPagination lang={lang} title="payroll_title" page={payroll} size={sizes.payroll}
          onPage={page => setPages(p => ({ ...p, payroll: page }))}
          onSize={size => { setSizes(s => ({ ...s, payroll: size })); setPages(p => ({ ...p, payroll: 1 })); }} />
      </section>
      <section className="kiosk-card" aria-label={t(lang, 'payroll_loans_title')}>
        <h3 className="kiosk-h3">{t(lang, 'payroll_loans_title')}</h3>
        {!visible || visible.loans.status === 'loading' ? <p role="status">{t(lang, 'loading')}</p> : null}
        {visible?.loans.error ? <p className="kiosk-message kiosk-message--error" role="alert">{kioskPayrollError(visible.loans.error, lang)}</p> : null}
        {visible?.loans.status === 'ready' && !loans.total ? <p className="kiosk-muted">{t(lang, 'payroll_loans_empty')}</p> : null}
        {loans.items.map(row => (
          <div key={row.id}>
            <h4 className="kiosk-h3">{row.loanNo} · {t(lang, `payroll_loan_${row.status}`)}</h4>
            <dl className="kiosk-stats">
              {[['payroll_principal', row.principalMinor], ['payroll_interest', row.interestMinor], ['payroll_owed', kioskLoanTotal(row)]].map(([key, amount]) => (
                <div key={key} className="kiosk-stats__row"><dt>{t(lang, key)}</dt><dd>{kioskMoney(amount, row.currency)}</dd></div>
              ))}
            </dl>
          </div>
        ))}
        {visible?.loans.status === 'error' ? <button type="button" className="kiosk-btn" onClick={retry}>{t(lang, 'try_again')}</button> : null}
        <KioskFinancialPagination lang={lang} title="payroll_loans_title" page={loans} size={sizes.loans}
          onPage={page => setPages(p => ({ ...p, loans: page }))}
          onSize={size => { setSizes(s => ({ ...s, loans: size })); setPages(p => ({ ...p, loans: 1 })); }} />
      </section>
    </>
  );
}

function KioskFinancialPagination({ lang, title, page, size, onPage, onSize }) {
  if (page.total <= 50) return null;
  return (
    <nav aria-label={t(lang, title)}>
      <p className="kiosk-muted">{t(lang, 'payroll_showing', page)} · {t(lang, 'payroll_page', page)}</p>
      <div className="kiosk-actions">
        <button type="button" className="kiosk-btn" disabled={page.page === 1} onClick={() => onPage(page.page - 1)}>{t(lang, 'payroll_previous')}</button>
        <button type="button" className="kiosk-btn" disabled={page.page === page.pages} onClick={() => onPage(page.page + 1)}>{t(lang, 'payroll_next')}</button>
      </div>
      <label className="kiosk-field">
        <span>{t(lang, 'payroll_page_size')}</span>
        <select className="kiosk-input" value={size} onChange={e => onSize(Number(e.target.value))}>
          {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </nav>
  );
}
