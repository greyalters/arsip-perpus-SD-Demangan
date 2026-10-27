// Vercel serverless function: GET /api/lookup?isbn=978...
// Looks an ISBN up on SIBI Kemendikbud and Perpusnas, which a browser page
// cannot query directly. Neither has an official public API, so both are
// best effort: if a site changes, that source just returns nothing.
// Add &debug=1 to see what each source answered.

const TIMEOUT = 7000;

// Run close to Indonesia (Singapore); some .go.id sites refuse far-away servers.
export const config = { regions: ['sin1'] };

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (perpus-sdd lookup)', Accept: '*/*', ...(opts.headers || {}) } });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}

const digits = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
const strip = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Walk any JSON and return the first object whose isbn field matches.
function findByIsbn(node, isbn) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    const key = Object.keys(node).find(k => /isbn/i.test(k));
    if (key && digits(node[key]).includes(isbn)) return node;
  }
  for (const v of Object.values(node)) { const hit = findByIsbn(v, isbn); if (hit) return hit; }
  return null;
}
const pick = (o, re) => { const k = Object.keys(o).find(k => re.test(k)); return k ? o[k] : ''; };

async function sibi(isbn, log) {
  const urls = [
    `https://api.buku.kemdikbud.go.id/api/catalogue/getTextBooks?limit=20&offset=0&title=${isbn}`,
    `https://api.buku.kemdikbud.go.id/api/catalogue/getTextBooks?limit=20&offset=0&isbn=${isbn}`,
    `https://buku.kemdikbud.go.id/api/catalogue/getTextBooks?limit=20&offset=0&title=${isbn}`,
  ];
  for (const u of urls) {
    try {
      const r = await get(u, { headers: { Accept: 'application/json' } });
      log.push({ source: 'sibi', url: u, status: r.status, sample: r.text.slice(0, 300) });
      if (r.status !== 200) continue;
      const hit = findByIsbn(JSON.parse(r.text), isbn);
      if (!hit) continue;
      const writers = pick(hit, /writer|author|penulis/i);
      return {
        title: strip(pick(hit, /^title$|judul/i) || pick(hit, /title/i)),
        authors: Array.isArray(writers) ? writers.map(w => w.name || w).join('; ') : strip(writers),
        publisher: strip(pick(hit, /publisher|penerbit/i)) || 'Kementerian Pendidikan, Kebudayaan, Riset, dan Teknologi',
        year: String(pick(hit, /year|tahun/i) || '').match(/\d{4}/)?.[0] || '',
        place: 'Jakarta', cat: 'Buku Pelajaran', source: 'SIBI Kemendikbud',
      };
    } catch (e) { log.push({ source: 'sibi', url: u, error: String(e), cause: String(e.cause?.code || e.cause?.message || '') }); }
  }
  return null;
}

async function perpusnas(isbn, log) {
  const u = `https://isbn.perpusnas.go.id/Account/SearchBuku?searchCat=ISBN&searchTxt=${isbn}`;
  try {
    const r = await get(u);
    log.push({ source: 'perpusnas', url: u, status: r.status, sample: r.text.slice(0, 300) });
    if (r.status !== 200) return null;
    // Result rows are an HTML table; take the row that contains the ISBN.
    const row = (r.text.match(/<tr[\s\S]*?<\/tr>/gi) || []).find(tr => digits(strip(tr)).includes(isbn));
    if (!row) return null;
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(strip).filter(Boolean);
    const title = cells.find(c => c.length > 3 && !/^[\d\-\s]+$/.test(c) && !digits(c).includes(isbn)) || '';
    const year = (cells.join(' ').match(/\b(19|20)\d{2}\b/) || [''])[0];
    const rest = cells.filter(c => c !== title && !/^[\d\-\s]+$/.test(c));
    return title ? { title, publisher: rest[0] || '', authors: rest[1] || '', year, source: 'Perpusnas' } : null;
  } catch (e) { log.push({ source: 'perpusnas', url: u, error: String(e), cause: String(e.cause?.code || e.cause?.message || '') }); return null; }
}

export default async function handler(req, res) {
  const isbn = digits(req.query.isbn);
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  if (isbn.length !== 10 && isbn.length !== 13) return res.status(400).json({ error: 'ISBN harus 10 atau 13 digit' });
  const log = [];
  const [a, b] = await Promise.all([sibi(isbn, log), perpusnas(isbn, log)]);
  const found = a || b || null;
  if (req.query.debug) return res.status(200).json({ isbn, found, log });
  return found ? res.status(200).json(found) : res.status(404).json({ error: 'tidak ditemukan' });
}
