// ================================================
// iFood Sync via Navegador (RPA) — Playwright + Drive + XLSX
// - Lê o único XLSX da pasta do Google Drive
// - Interpreta Nome / Estoque / Status Venda
// - Usa seu Chrome/Edge (perfil persistente) para operar no painel do iFood
// - "--dry-run": simula; "--login": só abre catálogo com seu perfil; padrão: sincroniza
// ================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const { chromium } = require('playwright');

const CONFIG = {
  TIMEZONE: process.env.TZ || 'America/Maceio',

  // Google Drive
  GDRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID,
  GOOGLE_AUTH_TYPE: process.env.GOOGLE_AUTH_TYPE || 'service_account', // service_account | oauth
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '', // ex.: ./sa.json
  GOOGLE_OAUTH_TOKEN_JSON: process.env.GOOGLE_OAUTH_TOKEN_JSON || '',       // se usar OAuth

  // iFood (painel web)
  IFOOD_LOGIN_URL: process.env.IFOOD_LOGIN_URL || 'https://portal.ifood.com.br/login',
  IFOOD_CATALOG_URL: process.env.IFOOD_CATALOG_URL || 'https://portal.ifood.com.br/menu/list',

  // Colunas EXATAS da planilha
  COL_PRODUCT: process.env.COL_PRODUCT || 'Nome',
  COL_QTY: process.env.COL_QTY || 'Estoque',
  COL_STATUS: process.env.COL_STATUS || 'Status Venda',

  // Regras
  STOP_SELL_AT_ZERO: (process.env.STOP_SELL_AT_ZERO || 'true').toLowerCase() === 'true',

  // Execução
  DRY_RUN: process.argv.includes('--dry-run'),
  LOGIN_MODE: process.argv.includes('--login'),
  EVIDENCE_DIR: process.env.EVIDENCE_DIR || './evidence',

  // Mapeamento opcional: Nome planilha -> Nome no iFood
  MAP_FILE: process.env.MAP_FILE || './map.json',

  // Chrome/Edge (perfil persistente)
  CHROME_CHANNEL: process.env.CHROME_CHANNEL || '', // 'chrome' | 'msedge' | ''
  CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR || '', // ...\User Data  OU  ...\User Data\Default
  CHROME_PROFILE: process.env.CHROME_PROFILE || '', // 'Default' | 'Profile 1' | etc (opcional)
  CHROME_EXE: process.env.CHROME_EXE || '', // caminho do executável (opcional)
};

// ---------- Utils ----------
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
const warn = (...a) => console.warn(new Date().toISOString(), '- WARN -', ...a);
const err = (...a) => console.error(new Date().toISOString(), '- ERROR -', ...a);

// ---------- Google Drive ----------
function getDriveClient() {
  if (CONFIG.GOOGLE_AUTH_TYPE === 'service_account') {
    if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new Error('Defina GOOGLE_SERVICE_ACCOUNT_JSON no .env (ex.: ./sa.json)');
    }
    const creds = JSON.parse(fs.readFileSync(path.resolve(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON), 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    return google.drive({ version: 'v3', auth });
  }
  if (!CONFIG.GOOGLE_OAUTH_TOKEN_JSON) {
    throw new Error('Defina GOOGLE_OAUTH_TOKEN_JSON no .env');
  }
  const token = JSON.parse(fs.readFileSync(path.resolve(CONFIG.GOOGLE_OAUTH_TOKEN_JSON), 'utf8'));
  const auth = new google.auth.OAuth2();
  auth.setCredentials(token);
  return google.drive({ version: 'v3', auth });
}

async function downloadLatestXlsxBuffer() {
  const drive = getDriveClient();
  if (!CONFIG.GDRIVE_FOLDER_ID) throw new Error('GDRIVE_FOLDER_ID não definido no .env');

  const q = `'${CONFIG.GDRIVE_FOLDER_ID}' in parents and trashed = false`;
  const { data } = await drive.files.list({
    q,
    orderBy: 'modifiedTime desc',
    pageSize: 1,
    fields: 'files(id,name,mimeType,modifiedTime)',
  });
  if (!data.files?.length) throw new Error('Nenhum arquivo encontrado na pasta do Drive');
  const file = data.files[0];

  const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), name: file.name, mimeType: file.mimeType };
}

function parseXlsxBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const firstSheetName = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows;
}

function loadMap() {
  if (!fs.existsSync(CONFIG.MAP_FILE)) return {};
  return JSON.parse(fs.readFileSync(CONFIG.MAP_FILE, 'utf8'));
}

// ---------- Helpers Playwright ----------
async function ensureEvidenceDir() {
  if (!fs.existsSync(CONFIG.EVIDENCE_DIR)) fs.mkdirSync(CONFIG.EVIDENCE_DIR, { recursive: true });
}

function resolveUserDataAndProfile() {
  if (!CONFIG.CHROME_USER_DATA_DIR) return null;

  let userDataDir = CONFIG.CHROME_USER_DATA_DIR;
  let profile = CONFIG.CHROME_PROFILE;

  // Se o usuário passou ...\User Data\Default diretamente, separe:
  const normalized = userDataDir.replace(/\//g, '\\');
  const m = normalized.match(/(.*\\User Data)\\([^\\]+)$/i);
  if (m && !profile) {
    userDataDir = m[1];
    profile = m[2]; // "Default" ou "Profile 1"
  }
  return { userDataDir, profile: profile || 'Default' };
}

async function openPersistentUserBrowser() {
  const resolved = resolveUserDataAndProfile();
  if (!resolved) throw new Error('Defina CHROME_USER_DATA_DIR no .env para usar o perfil do seu navegador');
  const { userDataDir, profile } = resolved;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: CONFIG.CHROME_CHANNEL || undefined,      // 'chrome' | 'msedge'
    executablePath: CONFIG.CHROME_EXE || undefined,   // opcional
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
    args: [
      `--profile-directory=${profile}`,
      '--start-maximized',
    ],
  });

  // Logs úteis por página
  context.on('page', p => {
    p.on('console', msg => log('[page-console]', msg.type(), msg.text()));
    p.on('pageerror', e => err('pageerror:', e.message));
    p.on('requestfailed', r => warn('requestfailed:', r.url(), r.failure()?.errorText || ''));
  });

  return context;
}

async function gotoCatalog(contextOrPage) {
  const isPage = typeof contextOrPage.goto === 'function';
  let page = isPage ? contextOrPage : (contextOrPage.pages()[0] || await contextOrPage.newPage());
  await page.bringToFront();

  // Garantir handlers mesmo na primeira aba
  page.on('console', (msg) => log('[page-console]', msg.type(), msg.text()));
  page.on('pageerror', (e) => err('pageerror:', e.message));
  page.on('requestfailed', (r) => warn('requestfailed:', r.url(), r.failure()?.errorText || ''));

  const primary = CONFIG.IFOOD_CATALOG_URL || 'https://portal.ifood.com.br/menu/list';
  const candidates = [
    primary,
    'https://portal.ifood.com.br/menu/list',
    'https://portal.ifood.com.br/catalog',
    'https://portal.ifood.com.br/catalog/menu'
  ];

  const tryNavigate = async (p, url) => {
    try {
      log('Abrindo:', url);
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      if (/portal\.ifood\.com\.br\/(menu|catalog)/i.test(p.url())) return true;

      // forçar via script
      await p.evaluate(u => { window.location.href = u; }, url);
      await p.waitForURL(/portal\.ifood\.com\.br\/(menu|catalog)/i, { timeout: 45000 });
      await p.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      return true;
    } catch (e) {
      warn('Falha ao abrir', url, e.message);
      return false;
    }
  };

  for (const url of candidates) {
    if (await tryNavigate(page, url)) {
      log('No painel do catálogo:', page.url());
      return page;
    }
  }

  // Se ainda preso, abrir uma aba nova “limpa”
  if (!isPage) {
    const fresh = await contextOrPage.newPage();
    fresh.on('console', (msg) => log('[page-console]', msg.type(), msg.text()));
    fresh.on('pageerror', (e) => err('pageerror:', e.message));
    fresh.on('requestfailed', (r) => warn('requestfailed:', r.url(), r.failure()?.errorText || ''));

    for (const url of candidates) {
      if (await tryNavigate(fresh, url)) {
        log('No painel do catálogo (nova aba):', fresh.url());
        try { if (page && page.url().startsWith('about:')) await page.close(); } catch {}
        return fresh;
      }
    }
  }

  throw new Error('Não consegui abrir o painel de catálogo do iFood (menu/catalog).');
}

// ---------- Busca/ação nos itens ----------
async function findAndOpenItem(page, keyword) {
  const search = page.getByPlaceholder(/buscar|pesquisar|search/i).first();
  try {
    await search.fill('');
    await search.fill(keyword);
    await search.press('Enter');
  } catch (_) { /* sem campo de busca, segue */ }
  await page.waitForTimeout(1200);
}

function cardLocator(page, keyword) {
  const rx = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return page.getByRole('article').filter({ hasText: rx }).first();
}

async function toggleAvailabilityIconOnly(card, shouldBeAvailable) {
  // 1) Botão com aria-pressed
  const toggleBtn = card.locator('button[aria-pressed]').first();
  if (await toggleBtn.isVisible().catch(() => false)) {
    const attr = await toggleBtn.getAttribute('aria-pressed');
    const isOn = attr === 'true';
    if (isOn !== shouldBeAvailable) {
      await toggleBtn.click();
      await card.page().waitForTimeout(500);
      return true;
    }
    return false;
  }

  // 2) Botão com SVG (ícone play/pause)
  const iconBtn = card.locator('button:has(svg)').first();
  if (await iconBtn.isVisible().catch(() => false)) {
    const svg = iconBtn.locator('svg').first();
    const html = await svg.evaluate(el => el.outerHTML).catch(() => '');
    const looksPlay = /play/i.test(html);
    const looksPause = /pause/i.test(html);

    // Heurística: play = está pausado (precisa ativar); pause = está ativo
    let isOn = null;
    if (looksPlay) isOn = false;
    if (looksPause) isOn = true;

    if (isOn === null || isOn !== shouldBeAvailable) {
      await iconBtn.click();
      await card.page().waitForTimeout(500);
      return true;
    }
    return false;
  }

  throw new Error('Botão de play/pause não localizado no card.');
}

async function setStockNumberInput(card, qty) {
  // 1) input[type=number]
  let input = card.locator('input[type="number"]').first();
  if (!(await input.isVisible().catch(() => false))) {
    // 2) primeiro input do card
    input = card.locator('input').first();
    if (!(await input.isVisible().catch(() => false))) return false;
  }
  await input.fill('');
  await input.type(String(Math.max(0, Math.floor(qty))));
  // salvar, se houver
  const save = card.getByRole('button', { name: /salvar|save|aplicar/i }).first();
  if (await save.isVisible().catch(() => false)) {
    await save.click();
    await card.page().waitForTimeout(600);
  } else {
    await card.page().keyboard.press('Tab');
    await card.page().waitForTimeout(300);
  }
  return true;
}

async function setAvailability(page, keyword, available) {
  await findAndOpenItem(page, keyword);
  const card = cardLocator(page, keyword);
  if (!(await card.isVisible().catch(() => false))) {
    throw new Error('Card do produto não encontrado');
  }
  const changed = await toggleAvailabilityIconOnly(card, available);
  if (changed) log(`Disponibilidade atualizada → ${keyword}: ${available}`);
  else log(`Disponibilidade já correta → ${keyword}: ${available}`);
  return changed;
}

async function setStockIfVisible(page, keyword, qty) {
  await findAndOpenItem(page, keyword);
  const card = cardLocator(page, keyword);
  if (!(await card.isVisible().catch(() => false))) return false;
  const ok = await setStockNumberInput(card, qty);
  if (ok) log(`Estoque atualizado → ${keyword}: ${qty}`);
  return ok;
}

// ---------- Core ----------
function isStatusAtivo(status) {
  const s = (status || '').toLowerCase();
  return /ativo|ativado|dispon[ií]vel|vendendo|on/.test(s) && !/inativo|pausado|off|indispon[ií]vel/.test(s);
}

function normalizeRows(rows) {
  const out = [];
  for (const r of rows) {
    const nome = String(r[CONFIG.COL_PRODUCT] ?? '').trim();
    const estoqueRaw = r[CONFIG.COL_QTY];
    const statusRaw = r[CONFIG.COL_STATUS];

    if (!nome) continue;
    if (/^total\s*itens\s*=\s*\d+/i.test(nome)) continue;

    const n = Number(estoqueRaw);
    const estoque = Number.isFinite(n) ? n : 0;
    const status = String(statusRaw ?? '').trim().toLowerCase();

    out.push({ nome, estoque, status });
  }
  return out;
}

async function runSync() {
  await ensureEvidenceDir();

  // 1) Drive → XLSX
  log('Baixando XLSX do Drive...');
  const { buffer: buf } = await downloadLatestXlsxBuffer();
  fs.writeFileSync(path.join(CONFIG.EVIDENCE_DIR, 'last.xlsx'), buf);

  // 2) Parse planilha
  const rows = parseXlsxBuffer(buf);
  log('Linhas na planilha:', rows.length);
  if (!rows.length) { warn('Planilha sem linhas.'); return; }

  const items = normalizeRows(rows);
  log('Itens com nome válido:', items.length);

  const map = loadMap();

  // 3) DRY-RUN
  if (CONFIG.DRY_RUN) {
    for (const it of items) {
      const nomeIf = map[it.nome] || it.nome;
      const ativo = isStatusAtivo(it.status);
      const available = CONFIG.STOP_SELL_AT_ZERO ? (ativo && it.estoque > 0) : ativo;
      log(`[DRY] ${nomeIf} -> available=${available} | estoque=${it.estoque} | status="${it.status}"`);
    }
    return;
  }

  // 4) "--login": só abre o catálogo e fecha
  if (CONFIG.LOGIN_MODE) {
    const context = await openPersistentUserBrowser();
    try {
      await gotoCatalog(context);
      log('Perfil persistente em uso. Fechando e saindo do modo --login.');
    } finally {
      await context.close();
    }
    return;
  }

  // 5) Execução "valendo"
  const context = await openPersistentUserBrowser();
  try {
    const page = await gotoCatalog(context);

    let ok = 0, fail = 0;
    for (const it of items) {
      const nomeIf = map[it.nome] || it.nome;
      const ativo = isStatusAtivo(it.status);
      const available = CONFIG.STOP_SELL_AT_ZERO ? (ativo && it.estoque > 0) : ativo;

      try {
        const a1 = await setAvailability(page, nomeIf, available);
        const a2 = await setStockIfVisible(page, nomeIf, it.estoque);
        if (a1 || a2) ok++; else ok++;
      } catch (e) {
        fail++;
        warn('Falha ao atualizar', nomeIf, e.message);
        await page.screenshot({ path: path.join(CONFIG.EVIDENCE_DIR, `err-${nomeIf.replace(/[^a-z0-9]+/gi,'_')}.png`) });
      }
    }

    log('Resumo: OK=', ok, ' FAIL=', fail);
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  runSync().catch(e => { err(e.stack || e.message); process.exitCode = 1; });
}
