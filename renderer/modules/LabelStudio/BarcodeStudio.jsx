import { useEffect, useState } from 'react';
import { Button, Input, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useAppStore } from '../../store/index.js';

export function BarcodeStudio() {
  const addToast = useAppStore((s) => s.addToast); const [value, setValue] = useState('123456789012'); const [format, setFormat] = useState('code128'); const [dataUrl, setDataUrl] = useState('');
  useEffect(() => { const id = setTimeout(() => window.api.labels.barcodePreview(value, format).then((r) => setDataUrl(r.dataUrl || '')).catch((e) => addToast(e.message, 'error')), 220); return () => clearTimeout(id); }, [value, format, addToast]);
  async function copy() { try { await navigator.clipboard.writeText(value); addToast('Barcode value copied', 'success'); } catch (e) { addToast(e.message, 'error'); } }
  async function savePng() { try { const folder = await window.api.files.pickFolder(); if (!folder) return; const res = await window.api.labels.saveBarcode(value, format, folder); addToast(`Saved to ${res.outputPath}`, 'success'); } catch (e) { addToast(e.message, 'error'); } }
  return <section className="page"><PageHeader title="Barcode Maker" subtitle="Create a scannable barcode or QR code without building a label template." />
    <div className="barcode-maker"><div className="barcode-maker__controls"><label>Format<Select value={format} onChange={(e) => setFormat(e.target.value)}><option value="code128">Code 128</option><option value="ean13">EAN-13</option><option value="upca">UPC-A</option><option value="code39">Code 39</option><option value="qr">QR code</option></Select></label><label>Value<Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Enter barcode data" /></label><p>Use Code 128 for general inventory values. EAN-13 and UPC-A require valid numeric lengths.</p><div className="barcode-actions"><Button variant="ghost" onClick={copy}>Copy value</Button><Button onClick={savePng} disabled={!dataUrl}>Save PNG…</Button></div></div><div className="barcode-paper">{dataUrl ? <img src={dataUrl} alt="Generated barcode" /> : <div>Enter a valid value</div>}<span>{format === 'qr' ? 'QR code' : format.toUpperCase()}</span></div></div>
  </section>;
}
