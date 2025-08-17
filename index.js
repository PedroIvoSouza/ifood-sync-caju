require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const { chromium } = require('playwright');

const CONFIG = {
  TIMEZONE: process.env.TZ || 'America/Maceio',
  // Google Drive
  GDRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID,
  GDRIVE_FILE_NAME: process.env.GDRIVE_FILE_NAME || '',
  GOOGLE_AUTH_TYPE: process.env.GOOGLE_AUTH_TYPE || 'service_account',
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  GOOGLE_OAUTH_TOKEN_JSON: process.env.GOOGLE_OAUTH_TOKEN_JSON || '',
  // iFood painel (parametrizável pois pode mudar de URL/layout)
  IFOOD_LOGIN_URL: process.env.IFOOD_LOGIN_URL || 'https://portal.ifood.com.br/login',
  IFOOD_CATALOG_URL: process.env.IFOOD_CATALOG_URL || 'https://portal.ifood.com.br/catalog',

  // Mapeamento & campos
  MAP_FILE: process.env.MAP_FILE || './map.json', // opcional: SKU -> Nome do item como aparece no iFood
  COL_PRODUCT: process.env.COL_PRODUCT || 'Nome',
  COL_QTY: process.env.COL_QTY || 'Estoque',
  COL_STATUS: process.env.COL_STATUS || 'Status Venda',
  STOP_SELL_AT_ZERO: (process.env.STOP_SELL_AT_ZERO || 'true').toLowerCase() === 'true',

  // Execução
  DRY_RUN: process.argv.includes('--dry-run'),
  LOGIN_MODE: process.argv.includes('--login'),
  STORAGE_STATE: process.env.STORAGE_STATE || './auth.json',
  EVIDENCE_DIR: process.env.EVIDENCE_DIR || './evidence',
};

const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
const warn = (...a) => console.warn(new Date().toISOString(), '- WARN -', ...a);
const err = (...a) => console.error(new Date().toISOString(), '- ERROR -', ...a);

// ------------------------------
// Google Drive auth
// ------------------------------
function getDriveClient() {
  if (CONFIG.GOOGLE_AUTH_TYPE === 'service_account') {
    if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Defina GOOGLE_SERVICE_ACCOUNT_JSON no .env');
    const creds = JSON.parse(fs.readFileSync(path.resolve(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON), 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    return google.drive({ version: 'v3', auth });
  }
  if (!CONFIG.GOOGLE_OAUTH_TOKEN_JSON) throw new Error('Defina GOOGLE_OAUTH_TOKEN_JSON');
  const token = JSON.parse(fs.readFileSync(path.resolve(CONFIG.GOOGLE_OAUTH_TOKEN_JSON), 'utf8'));
  const auth = new google.auth.OAuth2();
  auth.setCredentials(token);
  return google.drive({ version: 'v3', auth });
}

async function downloadLatestXlsxBuffer() {
  const drive = getDriveClient();
  // Sempre pegar o ÚNICO arquivo da pasta (como você pediu)
  const q = `'${CONFIG.GDRIVE_FOLDER_ID}' in parents and trashed = false`;
  const { data } = await drive.files.list({ q, pageSize: 1, fields: 'files(id, name, mimeType, modifiedTime)' });
  if (!data.files?.length) throw new Error('Nenhum arquivo na pasta');
  const file = data.files[0];
  const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), name: file.name, mimeType: file.mimeType };
}' in parents and name = '${CONFIG.GDRIVE_FILE_NAME.replace(/'/g, "\\'")}' and trashed = false`;
    const { data } = await drive.files.list({ q, fields: 'files(id, name, mimeType, modifiedTime)' });
    if (!data.files?.length) throw new Error('Arquivo não encontrado por nome');
    fileId = data.files[0].id;
  } else {
    const q = `'${CONFIG.GDRIVE_FOLDER_ID}' in parents and trashed = false`;
    const { data } = await drive.files.list({ q, orderBy: 'modifiedTime desc', pageSize: 1, fields: 'files(id, name, mimeType, modifiedTime)' });
    if (!data.files?.length) throw new Error('Nenhum arquivo na pasta');
    fileId = data.files[0].id;
  }
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

function parseXlsxBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const firstSheetName = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows;
});
  if (parsed.errors?.length) warn('Erros XLSX:', parsed.errors.slice(0, 3));
  return parsed.data;
}

function loadMap() {
  if (!fs.existsSync(CONFIG.MAP_FILE)) return {};
  return JSON.parse(fs.readFileSync(CONFIG.MAP_FILE, 'utf8'));
}

// ------------------------------
// Playwright helpers
// ------------------------------
async function ensureEvidenceDir() {
  if (!fs.existsSync(CONFIG.EVIDENCE_DIR)) fs.mkdirSync(CONFIG.EVIDENCE_DIR, { recursive: true });
}

async function openBrowser(headed = false) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    storageState: fs.existsSync(CONFIG.STORAGE_STATE) ? CONFIG.STORAGE_STATE : undefined,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function saveStorage(context) {
  await context.storageState({ path: CONFIG.STORAGE_STATE });
  log('Sessão salva em', CONFIG.STORAGE_STATE);
}

// ------------------------------
// Fluxos de UI (ajuste seletores conforme seu painel)
// ------------------------------
async function loginFlow(page) {
  log('Abrindo login:', CONFIG.IFOOD_LOGIN_URL);
  await page.goto(CONFIG.IFOOD_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  // Aqui NÃO preenchemos usuários/senhas por você — segurança.
  // Você fará o login manualmente (incluindo 2FA). Quando chegar no dashboard, seguimos.
  await page.waitForLoadState('networkidle');
  log('Faça login manualmente. Após login, pressione ENTER no terminal para continuar...');
  await new Promise((res) => process.stdin.once('data', res));
}

async function gotoCatalog(page) {
  log('Indo ao catálogo:', CONFIG.IFOOD_CATALOG_URL);
  await page.goto(CONFIG.IFOOD_CATALOG_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

async function findAndOpenItem(page, keyword) {
  // Estratégia genérica: usar busca do catálogo
  // Tente primeiro um campo de busca global
  const search = page.getByPlaceholder(/buscar|pesquisar|search/i).first();
  try { await search.fill(''); await search.fill(keyword); await search.press('Enter'); } catch {}
  await page.waitForTimeout(1200);
}

async function setAvailability(page, keyword, available) {
  await findAndOpenItem(page, keyword);
  // Tente encontrar um toggle perto do item
  // Heurística: procurar por um card com o título do produto e dentro dele um switch/checkbox
  const card = page.getByRole('article').filter({ hasText: new RegExp(keyword, 'i') }).first();
  // Botão/toggle de disponibilidade
  const toggle = card.getByRole('switch');
  const isChecked = await toggle.isChecked().catch(() => null);
  if (isChecked == null) throw new Error('Toggle de disponibilidade não encontrado');
  if ((available && !isChecked) || (!available && isChecked)) {
    if (CONFIG.DRY_RUN) { log(`[DRY] Disponibilidade → ${keyword}: ${available}`); return true; }
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
  // Heurística: procurar por campo de estoque caso exista no painel
  const card = page.getByRole('article').filter({ hasText: new RegExp(keyword, 'i') }).first();
  // Tenta localizar input com label/placeholder relacionado a 'estoque'
  const input = card.getByPlaceholder(/estoque|quantidade dispon[ií]vel|stock/i).first();
  const exists = await input.isVisible().catch(() => false);
  if (!exists) { return false; } // alguns paineis não têm controle de quantidade
  if (CONFIG.DRY_RUN) { log(`[DRY] Estoque → ${keyword}: ${qty}`); return true; }
  await input.fill('');
  await input.type(String(Math.max(0, Math.floor(qty))));
  // salvar, se houver botão
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
  const input = priceInputs.nth(0);
  if (CONFIG.DRY_RUN) { log(`[DRY] Preço → ${keyword}: ${price}`); return true; }
  await input.fill('');
  await input.type(String(price));
  // Procurar e clicar em salvar, se existir
  const saveButton = card.getByRole('button', { name: /salvar|save|aplicar/i }).first();
  if (await saveButton.isVisible().catch(() => false)) {
    await saveButton.click();
    await page.waitForTimeout(800);
  } else {
    // Alguns paineis salvam automaticamente ao desfocar
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
  }
  log(`Preço atualizado → ${keyword}: ${price}`);
  return true;
}

// ------------------------------
// Core: processar XLSX e aplicar mudanças
// ------------------------------
async function runSync() {
  await ensureEvidenceDir();
  log('Baixando XLSX do Drive...');
  const { buffer: buf, name } = await downloadLatestXlsxBuffer();
  fs.writeFileSync(path.join(CONFIG.EVIDENCE_DIR, 'last.xlsx'), buf);
  const rows = parseXlsxBuffer(buf);
  log('Linhas:', rows.length);
  if (!rows.length) { warn('Planilha sem linhas.'); return; }
  // Normalização básica
  const norm = rows.map(r => ({
    nome: String(r[CONFIG.COL_PRODUCT] ?? '').trim(),
    estoque: Number(r[CONFIG.COL_QTY] ?? 0),
    status: String(r[CONFIG.COL_STATUS] ?? '').trim().toLowerCase()
  })).filter(x => x.nome);
  log('Itens com nome válido:', norm.length);

  const map = loadMap();

  const browser = await chromium.launch({ headless: !CONFIG.LOGIN_MODE });
  const context = await browser.newContext({
    storageState: fs.existsSync(CONFIG.STORAGE_STATE) ? CONFIG.STORAGE_STATE : undefined,
  });
  const page = await context.newPage();

  // Se não existir storageState e não estiver em modo login, obrigar primeiro login
  if (!fs.existsSync(CONFIG.STORAGE_STATE) && !CONFIG.LOGIN_MODE) {
    warn('Nenhuma sessão salva. Rode "npm run login" primeiro.');
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
  for (const row of norm) {
    const nome = row.nome;
    const qty = isFinite(row.estoque) ? row.estoque : 0;
    const statusAtivo = ['ativo','ativado','disponível','disponivel','on'].includes(row.status);
    const available = statusAtivo && qty > 0; // regra: respeita Status Venda e zera quando estoque == 0

    const keyword = nome; // busca por nome direto no catálogo do iFood

    try {
      const a1 = await setAvailability(page, keyword, available);
      const a2 = await setStockIfVisible(page, keyword, qty); // tenta ajustar campo de estoque, se existir
      if (a1 || a2) ok++; else ok++;
    } catch (e) {
      fail++;
      warn('Falha ao atualizar', nome, e.message);
      await page.screenshot({ path: path.join(CONFIG.EVIDENCE_DIR, `err-${nome.replace(/[^a-z0-9]+/gi,'_')}.png`) });
    }
  }

  log('Resumo: OK=', ok, ' FAIL=', fail);
  await context.storageState({ path: CONFIG.STORAGE_STATE });
  await browser.close();
}

if (require.main === module) {
  runSync().catch(e => { err(e.stack || e.message); process.exitCode = 1; });
}
