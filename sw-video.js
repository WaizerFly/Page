/* Service worker: показывает виртуальный файл media/sw.mp4,
   собирая его на лету из parts/*.bin.

   Главное — поддержка заголовка Range: браузерный <video> запрашивает
   произвольные куски файла (и при перемотке, и чтобы найти moov-атом),
   а мы переводим эти диапазоны в диапазоны внутри нужных частей.
   В память ничего целиком не грузится — данные текут потоком. */

const MANIFEST = {
  type: 'video/mp4',
  size: 163099656,
  parts: [
    { url: 'parts/sw-000.bin', size: 20000000 },
    { url: 'parts/sw-001.bin', size: 20000000 },
    { url: 'parts/sw-002.bin', size: 20000000 },
    { url: 'parts/sw-003.bin', size: 20000000 },
    { url: 'parts/sw-004.bin', size: 20000000 },
    { url: 'parts/sw-005.bin', size: 20000000 },
    { url: 'parts/sw-006.bin', size: 20000000 },
    { url: 'parts/sw-007.bin', size: 20000000 },
    { url: 'parts/sw-008.bin', size: 3099656  }
  ]
};

const VIRTUAL_NAME = 'media/sw.mp4';   // не должен совпадать с реальным файлом
const RETRIES = 4;

/* всё считаем относительно scope — сайт может лежать и в подпапке */
const SCOPE = self.registration.scope;
const VIRTUAL_URL = new URL(VIRTUAL_NAME, SCOPE).href;
const PARTS = MANIFEST.parts.map(p => ({ url: new URL(p.url, SCOPE).href, size: p.size }));

const OFFSETS = [];
let TOTAL = 0;
for (const p of PARTS) { OFFSETS.push(TOTAL); TOTAL += p.size; }
if (TOTAL !== MANIFEST.size) console.warn('sw-video: сумма частей', TOTAL, '≠ size', MANIFEST.size);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.url.split('?')[0] !== VIRTUAL_URL) return;   // остальное — как обычно
  event.respondWith(serve(event.request));
});

/* ---------- ответ на запрос виртуального файла ---------- */
function serve(request) {
  const headers = {
    'Content-Type': MANIFEST.type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(TOTAL) } });
  }
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const range = parseRange(request.headers.get('Range'));

  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${TOTAL}` } });
  }
  if (!range) {
    return new Response(streamRange(0, TOTAL - 1), {
      status: 200,
      headers: { ...headers, 'Content-Length': String(TOTAL) }
    });
  }
  return new Response(streamRange(range.start, range.end), {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${TOTAL}`
    }
  });
}

function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';

  let start, end;
  if (m[1] === '') {
    const len = Number(m[2]);                 // «последние N байт» — так ищут moov
    if (!m[2] || !len) return 'invalid';
    start = Math.max(0, TOTAL - len);
    end = TOTAL - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? TOTAL - 1 : Math.min(Number(m[2]), TOTAL - 1);
  }
  if (!(start <= end) || start >= TOTAL) return 'invalid';
  return { start, end };
}

/* ---------- поток байт [start..end] поверх частей ---------- */
function partIndexAt(pos) {
  let lo = 0, hi = PARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (OFFSETS[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

async function openPart(part, from, to) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(part.url, { headers: { Range: `bytes=${from}-${to}` } });
      if (!res.ok || !res.body) throw new Error(`${part.url}: HTTP ${res.status}`);
      return {
        reader: res.body.getReader(),
        skip: res.status === 206 ? 0 : from,   // сервер проигнорировал Range — отмотаем сами
        want: to - from + 1
      };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

function streamRange(start, end) {
  let pos = start;
  let cur = null;

  const dropCurrent = async () => {
    if (!cur) return;
    const { reader } = cur;
    cur = null;
    try { await reader.cancel(); } catch (_) {}
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (pos > end) { await dropCurrent(); controller.close(); return; }

          if (!cur) {
            const i = partIndexAt(pos);
            const base = OFFSETS[i];
            cur = await openPart(PARTS[i], pos - base, Math.min(end - base, PARTS[i].size - 1));
          }

          const { done, value } = await cur.reader.read();
          if (done) {
            if (cur.want > 0) throw new Error(`часть оборвалась, не хватает ${cur.want} байт`);
            cur = null;
            continue;
          }

          let chunk = value;
          if (cur.skip) {
            if (chunk.length <= cur.skip) { cur.skip -= chunk.length; continue; }
            chunk = chunk.subarray(cur.skip);
            cur.skip = 0;
          }
          if (chunk.length > cur.want) chunk = chunk.subarray(0, cur.want);

          cur.want -= chunk.length;
          pos += chunk.length;
          controller.enqueue(chunk);
          if (!cur.want) await dropCurrent();
          return;
        }
      } catch (e) {
        await dropCurrent();
        controller.error(e);
      }
    },
    cancel() { return dropCurrent(); }
  });
}
