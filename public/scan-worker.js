// Фоновый поток распознавания штрихкодов и QR-кодов.
// Всё тяжёлое (распознавание кадра) выполняется здесь, а не в основном потоке —
// поэтому интерфейс кассы не подтормаживает даже на слабых моноблоках.
// Движок: ZXing-C++ (WebAssembly), лежит локально в /vendor/zxing.
/* global ZXingWASM, BarcodeDetector */

let ready = false;
let native = null; // встроенный в браузер BarcodeDetector (Android/macOS) — ещё быстрее
let canvas = null;
let ctx = null;

const ZXING_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'ITF', 'QRCode', 'DataMatrix'];
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];
const READER_OPTIONS = {
  formats: ZXING_FORMATS,
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
  textMode: 'Plain', // сырой текст: для маркировки (GS1) — «01…21…» с разделителями
};

async function init() {
  try {
    if (typeof BarcodeDetector !== 'undefined') {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (supported.includes('ean_13') && supported.includes('qr_code')) {
        native = new BarcodeDetector({ formats: NATIVE_FORMATS.filter(f => supported.includes(f)) });
      }
    }
  } catch (e) { native = null; }

  if (!native) {
    importScripts('/vendor/zxing/zxing-reader.js');
    // Загружаем и компилируем WASM сразу, чтобы первый кадр распознавался без задержки
    await ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? '/vendor/zxing/zxing_reader.wasm' : prefix + path),
      },
      fireImmediately: true,
    });
  }
  ready = true;
  postMessage({ type: 'ready', engine: native ? 'native' : 'zxing' });
}

function toImageData(frame) {
  if (frame instanceof ImageData) return frame;
  // ImageBitmap → ImageData через OffscreenCanvas (всё внутри фонового потока)
  if (!canvas || canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas = new OffscreenCanvas(frame.width, frame.height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(frame, 0, 0);
  if (frame.close) frame.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'frame') return;
  if (!ready) { postMessage({ type: 'result', id: msg.id, text: null }); return; }
  try {
    let text = null;
    if (native) {
      const found = await native.detect(msg.frame);
      if (msg.frame.close) msg.frame.close();
      text = found && found[0] ? found[0].rawValue : null;
    } else {
      const results = await ZXingWASM.readBarcodes(toImageData(msg.frame), READER_OPTIONS);
      const ok = results.find(r => r.isValid && r.text);
      text = ok ? ok.text : null;
    }
    postMessage({ type: 'result', id: msg.id, text });
  } catch (err) {
    postMessage({ type: 'result', id: msg.id, text: null, error: String(err && err.message || err) });
  }
};

init().catch(err => postMessage({ type: 'error', error: String(err && err.message || err) }));
