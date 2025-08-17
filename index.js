// ================================================
// iFood Sync via Navegador (sem API) — Playwright
// Lê XLSX no Google Drive e atualiza itens no painel do iFood
// - Primeiro run: login manual (salva sessão em auth.json)
// - Demais runs: headless usando a sessão salva
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
  IFOOD_CATALOG_URL: process.env.IFOOD_CATALOG_URL || 'https://portal.ifood.com.br/catalog',

  // Colunas EXATAS da planilha (podem ser alteradas no .env)
  COL_PRODUCT: process.env.COL_PRODUCT || 'Nome',
  COL_QTY: process.env.COL_QTY || 'Estoque',
  COL_STATUS: process.env.COL_STATUS || 'Status Venda',

  // Regras
  STOP_SELL_AT_ZERO: (process.env.STOP_SELL_AT_ZERO || 'true').toLowerCase() === 'true',

  // Execução
  DRY_RUN: process.argv.includes('--dry-run'),
  LOGIN_MODE: process.argv.includes('--login'),
  STORAGE_STATE: process.env.STORAGE_STATE || './auth.json',
  EVIDENCE_DIR: process.env.EVIDENCE_DIR || './evidence',

  // Mapeamento opcional: Nome da planilha -> Nome exibido no iFood
  MAP_FILE: process.env.MAP_FILE || './map.json',
};

// ---------- Utils de log ----------
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
  // OAuth token previamente salvo
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

  // Sempre pegar o ÚNICO arquivo (ou o mais recente) da pasta
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

// ---------- Playwright helpers ----------
async function ensureEvidenceDir() {
  if (!fs.existsSync(CONFIG.EVIDENCE_DIR)) fs.mkdirSync(CONFIG.EVIDENCE_DIR, { recursive: true });
}

async function saveStorage(context) {
  await context.storageState({ path: CONFIG.STORAGE_STATE });
  log('Sessão salva em', CONFIG.STORAGE_STATE);
}

// ---------- Fluxos de UI ----------
async function loginFlow(page) {
  log('Abrindo login:', CONFIG.IFOOD_LOGIN_URL);
  await page.goto(CONFIG.IFOOD_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  log('Faça login manualmente (2FA incluso). Quando terminar, volte ao terminal e pressione ENTER.');
  await new Promise((res) => process.stdin.once('data', res));
}

async function gotoCatalog(page) {
  log('Indo ao catálogo:', CONFIG.IFOOD_CATALOG_URL);
  await page.goto(CONFIG.IFOOD_CATALOG_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

async function findAndOpenItem(page, keyword) {
  // Estratégia genérica para buscar item
  const search = page.getByPlaceholder(/buscar|pesquisar|search/i).first();
  try {
    await search.fill('');
    await search.fill(keyword);
    await search.press('Enter');
  } catch (_) { /* ignora se não houver campo de busca */ }
  await page.waitForTimeout(1200);
}

async function setAvailability(page, keyword, available) {
  await findAndOpenItem(page, keyword);

  const card = page.getByRole('article').filter({ hasText: new RegExp(keyword, 'i') }).first();
  const toggle = card.getByRole('switch');
  const isChecked = await toggle.isChecked().catch(() => null);
  if (isChecked == null) throw new Error('Toggle de disponibilidade não encontrado');

  if ((available && !isChecked) || (!available && isChecked)) {
    await toggle.click();
    await page.waitForTimeout(500);
    log(`Disponibilidade atualizada → ${keyword}: ${available}`);
    return true;
  }
  log(`Disponibilidade já correta → ${keyword}: ${available}`);
  return false;
}

async function setStockIfVisible(page, keyword, qty) {
  await findAndOpenItem(page, keyword);

  const card = page.getByRole('article').filter({ hasText: new RegExp(keyword, 'i') }).first();
  // Tenta localizar input de estoque
  const input = card.getByPlaceholder(/estoque|quantidade dispon[ií]vel|stock/i).first();
  const exists = await input.isVisible().catch(() => false);
  if (!exists) return false; // painel pode não ter campo numérico de estoque

  await input.fill('');
  await input.type(String(Math.max(0, Math.floor(qty))));

  const save = card.getByRole('button', { name: /salvar|save|aplicar/i }).first();
  if (await save.isVisible().catch(() => false)) {
    await save.click();
    await page.waitForTimeout(600);
  } else {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
  }
  log(`Estoque atualizado → ${keyword}: ${qty}`);
  return true;
}

// ---------- Core ----------
function normalizeRows(rows) {
  const out = [];
  for (const r of rows) {
    const nome = String(r[CONFIG.COLL_PRODUCT] ?? r[CONFIG.COL_PRODUCT] ?? '').trim(); // tolera typo acidental
    const estoqueRaw = r[CONFIG.COL_QTY];
    const statusRaw = r[CONFIG.COL_STATUS];

    if (!nome) continue;

    const estoque = Number.isFinite(Number(estoqueRaw)) ? Number(estoqueRaw) : 0;
    const status = String(statusRaw ?? '').trim().toLowerCase();

    out.push({ nome, estoque, status });
  }
  return out;
}

function isStatusAtivo(status) {
  const s = (status || '').toLowerCase();
  // cobre variações comuns
  return /ativo|ativado|dispon[ií]vel|on|vendendo/.test(s) && !/inativo|pausado|off|indispon[ií]vel/.test(s);
}

async function runSync() {
  await ensureEvidenceDir();

  log('Baixando XLSX do Drive...');
  const { buffer: buf, name } = await downloadLatestXlsxBuffer();
  fs.writeFileSync(path.join(CONFIG.EVIDENCE_DIR, 'last.xlsx'), buf);

  const rows = parseXlsxBuffer(buf);
  log('Linhas na planilha:', rows.length);
  if (!rows.length) { warn('Planilha sem linhas.'); return; }

  const items = normalizeRows(rows);
  log('Itens com nome válido:', items.length);

  const map = loadMap();

  // DRY-RUN: apenas mostra o que faria, sem abrir navegador
  if (CONFIG.DRY_RUN) {
    for (const it of items) {
      const nomeIf = map[it.nome] || it.nome;
      const ativo = isStatusAtivo(it.status);
      const available = CONFIG.STOP_SELL_AT_ZERO ? (ativo && it.estoque > 0) : ativo;
      log(`[DRY] ${nomeIf} -> available=${available} | estoque=${it.estoque} | status="${it.status}"`);
    }
    return;
  }

  // Precisa de sessão salva ou modo login
  const browser = await chromium.launch({ headless: !CONFIG.LOGIN_MODE });
  const context = await browser.newContext({
    storageState: fs.existsSync(CONFIG.STORAGE_STATE) ? CONFIG.STORAGE_STATE : undefined,
  });
  const page = await context.newPage();

  if (!fs.existsSync(CONFIG.STORAGE_STATE) && !CONFIG.LOGIN_MODE) {
    warn('Nenhuma sessão salva. Rode: npm run login');
    await browser.close();
    return;
  }

  if (CONFIG.LOGIN_MODE) {
    await loginFlow(page);
    await saveStorage(context);
    await browser.close();
    return;
  }

  await gotoCatalog(page);

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
  await context.storageState({ path: CONFIG.STORAGE_STATE });
  await browser.close();
}

if (require.main === module) {
  runSync().catch(e => { err(e.stack || e.message); process.exitCode = 1; });
}
