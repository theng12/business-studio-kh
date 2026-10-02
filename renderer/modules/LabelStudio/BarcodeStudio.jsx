import { useEffect, useState } from 'react';
import { Button, Field, Input, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useAppStore } from '../../store/index.js';

export function BarcodeStudio() {
  const addToast = useAppStore((s) => s.addToast); const [value, setValue] = useState('123456789012'); const [format, setFormat] = useState('code128'); const [dataUrl, setDataUrl] = useState('');
  useEffect(() => { const id = setTimeout(() => window.api.labels.barcodePreview(value, format).then((r) => setDataUrl(r.dataUrl || '')).catch((e) => addToast(e.message, 'error')), 220); return () => clearTimeout(id); }, [value, format, addToast]);
  async function copy() { try { await navigator.clipboard.writeText(value); addToast('Barcode value copied', 'success'); } catch (e) { addToast(e.message, 'error'); } }
  async function savePng() { try { const folder = await window.api.files.pickFolder(); if (!folder) return; const res = await window.api.labels.saveBarcode(value, format, folder); addToast(`Saved to ${res.outputPath}`, 'success'); } catch (e) { addToast(e.message, 'error'); } }
  return <section className="page"><PageHeader title="Barcode Maker" subtitle="Create a scannable barcode or QR code without building a label template." />
    <div className="barcode-maker">
      <div className="barcode-maker__controls">
        <Field label="Format">
          {({ id }) => <Select id={id} value={format} onChange={(e) => setFormat(e.target.value)}><option value="code128">Code 128</option><option value="ean13">EAN-13</option><option value="upca">UPC-A</option><option value="code39">Code 39</option><option value="qr">QR code</option></Select>}
        </Field>
        <Field label="Value" hint="Code 128 suits general inventory values. EAN-13 and UPC-A need a valid numeric length.">
          {({ id }) => <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Enter barcode data" />}
        </Field>
        <div className="barcode-actions">
          <Button onClick={copy}>Copy value</Button>
          <Button variant="primary" onClick={savePng} disabled={!dataUrl} title={dataUrl ? undefined : 'Enter a value this format accepts first'}>Save PNG…</Button>
        </div>
      </div>
      <div className="barcode-paper">{dataUrl ? <img src={dataUrl} alt="Generated barcode" /> : <div className="muted">Enter a valid value</div>}<span className="barcode-paper__format">{format === 'qr' ? 'QR code' : format.toUpperCase()}</span></div>
    </div>
  </section>;
}
