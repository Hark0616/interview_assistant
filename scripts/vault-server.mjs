#!/usr/bin/env node
/**
 * Cofre local de API keys — SOLO escucha en 127.0.0.1 (no expone tu PC a Internet).
 *
 * Uso:
 *   set IA_VAULT_TOKEN=tu_secreto_largo_y_unico
 *   node scripts/vault-server.mjs
 *
 * Opcional: IA_VAULT_PORT=3847  IA_VAULT_FILE=%USERPROFILE%\.ia-vault.json
 *
 * API (misma forma sirve si la despliegas detrás de HTTPS con auth en la nube):
 *   GET  /v1/api-keys  →  { "apiKeys": { "gemini": "", "groq": "", "openrouter": "" } }
 *   PUT  /v1/api-keys  body JSON igual, header Authorization: Bearer <token>
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOST = '127.0.0.1';
const PORT = Number(process.env.IA_VAULT_PORT || 3847);
const TOKEN = String(process.env.IA_VAULT_TOKEN || '').trim();
const FILE = process.env.IA_VAULT_FILE || path.join(os.homedir(), '.interview-assistant-vault.json');

function readVault() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.apiKeys === 'object') return data;
  } catch {
    /* archivo ausente o corrupto */
  }
  return { apiKeys: { gemini: '', groq: '', openrouter: '' } };
}

function writeVault(body) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(body, null, 2), 'utf8');
}

function send(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function unauthorized(res) {
  send(res, 401, { error: 'No autorizado' });
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m && m[1] === TOKEN;
}

const server = http.createServer((req, res) => {
  // CORS mínimo (solo útil si algo en el navegador llamara sin extensión; la extensión tiene permisos propios)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${HOST}`);

  if (url.pathname !== '/v1/api-keys') {
    return send(res, 404, { error: 'No encontrado' });
  }

  if (!TOKEN) {
    return send(res, 503, { error: 'IA_VAULT_TOKEN no está definido. Apaga el servidor y configura un token.' });
  }

  if (!checkAuth(req)) {
    return unauthorized(res);
  }

  if (req.method === 'GET') {
    return send(res, 200, readVault());
  }

  if (req.method === 'PUT') {
    let chunks = '';
    req.on('data', (c) => { chunks += c; if (chunks.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(chunks || '{}');
        if (!parsed.apiKeys || typeof parsed.apiKeys !== 'object') {
          return send(res, 400, { error: 'JSON inválido: falta apiKeys' });
        }
        const apiKeys = {
          gemini: String(parsed.apiKeys.gemini || ''),
          groq: String(parsed.apiKeys.groq || ''),
          openrouter: String(parsed.apiKeys.openrouter || ''),
        };
        writeVault({ apiKeys });
        return send(res, 200, { ok: true, apiKeys });
      } catch {
        return send(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  send(res, 405, { error: 'Método no permitido' });
});

server.listen(PORT, HOST, () => {
  console.log(`[ia-vault] http://${HOST}:${PORT}/v1/api-keys`);
  console.log(`[ia-vault] archivo: ${FILE}`);
  console.log('[ia-vault] solo accesible desde esta máquina (127.0.0.1). No abras este puerto en el router.');
});

server.on('error', (err) => {
  console.error('[ia-vault]', err.message);
  process.exit(1);
});
