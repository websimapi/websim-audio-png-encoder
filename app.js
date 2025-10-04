const els = {
  file: document.getElementById('fileInput'),
  width: document.getElementById('width'),
  widthOut: document.getElementById('widthOut'),
  fileName: document.getElementById('fileName'),
  fileSize: document.getElementById('fileSize'),
  canvasSize: document.getElementById('canvasSize'),
  encodeBtn: document.getElementById('encodeBtn'),
  saveBtn: document.getElementById('saveBtn'),
  clearBtn: document.getElementById('clearBtn'),
  canvas: document.getElementById('canvas'),
  codeBlock: document.getElementById('codeBlock'),
  copyCodeBtn: document.getElementById('copyCodeBtn'),
};

const MAGIC = new TextEncoder().encode('AUD2IMG!'); // 8 bytes
const HEADER_BYTES = 8 /*magic*/ + 4 /*len*/;       // 12 total

let fileData = null; // { name, type, bytes: Uint8Array, packed: Uint8Array, width, height }

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B','KB','MB','GB'];
  let i = 0, x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function updateWidthOut() {
  els.widthOut.textContent = `${els.width.value} px`;
  if (fileData?.packed) {
    const w = parseInt(els.width.value, 10);
    const {height} = dimsFor(w, fileData.packed.length);
    els.canvasSize.textContent = `${w} × ${height}px`;
  }
}

els.width.addEventListener('input', updateWidthOut);

els.file.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const bytes = new Uint8Array(buf);
  fileData = { name: f.name, type: f.type || 'application/octet-stream', bytes, packed: null, width: 0, height: 0 };
  els.fileName.textContent = f.name;
  els.fileSize.textContent = fmtBytes(bytes.length);
  els.encodeBtn.disabled = false;
  els.saveBtn.disabled = true;
  els.canvasSize.textContent = '—';
});

els.encodeBtn.addEventListener('click', () => {
  if (!fileData) return;
  const packed = packWithHeader(fileData.bytes);
  const width = parseInt(els.width.value, 10);
  const { width: w, height: h } = drawToCanvas(els.canvas, packed, width);
  fileData.packed = packed;
  fileData.width = w;
  fileData.height = h;
  els.canvasSize.textContent = `${w} × ${h}px`;
  els.saveBtn.disabled = false;
});

els.saveBtn.addEventListener('click', async () => {
  if (!fileData?.packed) return;
  const blob = await new Promise(res => els.canvas.toBlob(res, 'image/png'));
  const base = fileData.name.replace(/\.[^/.]+$/, '');
  const outName = `${base || 'audio'}.encoded.png`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
});

els.clearBtn.addEventListener('click', () => {
  els.file.value = '';
  els.fileName.textContent = '—';
  els.fileSize.textContent = '—';
  els.canvasSize.textContent = '—';
  els.encodeBtn.disabled = true;
  els.saveBtn.disabled = true;
  const ctx = els.canvas.getContext('2d');
  ctx.clearRect(0,0,els.canvas.width,els.canvas.height);
  fileData = null;
});

function dimsFor(targetWidth, totalBytes) {
  const w = Math.max(1, targetWidth|0);
  const pixels = Math.ceil(totalBytes / 3);
  const h = Math.ceil(pixels / w);
  return { width: w, height: h };
}

function packWithHeader(bytes) {
  const len = bytes.length >>> 0;
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(8, len, true); // little-endian
  const body = new Uint8Array(header.length + bytes.length);
  body.set(header, 0);
  body.set(bytes, header.length);
  const pad = (3 - (body.length % 3)) % 3;
  if (pad) {
    const out = new Uint8Array(body.length + pad);
    out.set(body, 0);
    // pad zeros
    return out;
  }
  return body;
}

function drawToCanvas(canvas, packedBytes, targetWidth) {
  const { width, height } = dimsFor(targetWidth, packedBytes.length);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(width, height);
  const data = img.data; // RGBA
  // Map bytes to RGB, set A=255
  let si = 0; // source index over packedBytes
  for (let p = 0, di = 0; p < width * height; p++, di += 4) {
    data[di]     = packedBytes[si++] ?? 0;
    data[di + 1] = packedBytes[si++] ?? 0;
    data[di + 2] = packedBytes[si++] ?? 0;
    data[di + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { width, height };
}

// Decoding snippet shown to user
const decodeSnippet = `async function decodeFromPNG(imgOrBlob) {
  // Accepts HTMLImageElement, HTMLCanvasElement, ImageBitmap, or Blob/File of PNG
  const getBitmap = async (src) => {
    if (src instanceof ImageBitmap) return src;
    if (src instanceof HTMLCanvasElement) return await createImageBitmap(src);
    if (src instanceof Blob) return await createImageBitmap(await src.arrayBuffer().then(b => new Blob([b])));
    if (src instanceof HTMLImageElement) return await createImageBitmap(src);
    throw new Error('Unsupported source');
  };
  const bmp = await getBitmap(imgOrBlob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height); // RGBA
  // Rebuild byte stream from RGB channels
  const bytes = new Uint8Array((data.length / 4) * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    bytes[j++] = data[i];     // R
    bytes[j++] = data[i + 1]; // G
    bytes[j++] = data[i + 2]; // B
  }
  // Verify header
  const MAGIC = new TextEncoder().encode('AUD2IMG!');
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) throw new Error('Magic header mismatch');
  }
  const dv = new DataView(bytes.buffer, 0, bytes.byteLength);
  const length = dv.getUint32(8, true);
  // Slice payload
  const payload = bytes.slice(12, 12 + length);
  return payload; // Uint8Array of original file bytes
}`;

els.codeBlock.textContent = decodeSnippet;

els.copyCodeBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.codeBlock.textContent);
    pulse(els.copyCodeBtn, 'Copied');
  } catch (e) {
    pulse(els.copyCodeBtn, 'Copy failed');
  }
});

function pulse(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 900);
}

// Initialize width output
updateWidthOut();

