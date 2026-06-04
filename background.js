// background.js — Service Worker
// Soporte multi-proveedor: Gemini, Groq, OpenRouter
// La gestión del panel pop-out vive en panelManager.js (importScripts).

importScripts('panelManager.js');
const DEBUG_PROMPT_LOGS = true;

// Atajo global (configurable en chrome://extensions/shortcuts) → pestaña Meet activa
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-overlay-stealth') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY_STEALTH' }).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_AI_SUGGESTION') {
    handleAISuggestion(request.data)
      .then(result => sendResponse({ success: true, suggestion: result.text, truncated: result.truncated }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === 'TEST_API_KEY') {
    testApiKey(request.provider, request.apiKey, request.model)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === 'LIST_PROVIDER_MODELS') {
    const { provider, apiKey, openRouterOnlyFree } = request;
    let promise;
    if (provider === 'gemini') {
      promise = listGeminiModels(apiKey);
    } else if (provider === 'groq') {
      promise = listGroqModels(apiKey);
    } else if (provider === 'openrouter') {
      promise = listOpenRouterModels(apiKey, {
        onlyFree: openRouterOnlyFree !== false
      });
    } else {
      promise = Promise.reject(new Error('Proveedor desconocido para listar modelos.'));
    }
    promise
      .then((models) => sendResponse({ success: true, models }))
      .catch((err) => sendResponse({ success: false, error: err.message, models: [] }));
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ai-stream') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'GET_AI_SUGGESTION_STREAM') {
        handleAISuggestionStream(msg.data, port);
      }
    });
  }
});

// ── Providers ──

function normalizeProviderError(provider, responseStatus, rawMessage) {
  const msg = String(rawMessage || '');

  if (responseStatus === 401) {
    if (provider === 'groq') return 'API key de Groq inválida o expirada.';
    if (provider === 'openrouter') return 'API key de OpenRouter inválida o expirada.';
    return 'API key inválida o expirada.';
  }

  if (provider === 'gemini') {
    const lower = msg.toLowerCase();
    const isQuota0 =
      lower.includes('quota exceeded') &&
      lower.includes('limit: 0') &&
      lower.includes('free_tier');

    if (isQuota0) {
      return [
        'Tu proyecto de Gemini tiene cuota gratis en 0 (limit: 0).',
        'Esto suele pasar con cuentas/proyectos nuevos sin cuota habilitada.',
        'Prueba: 1) crear otra API key en AI Studio, 2) cambiar a modelo gemini-1.5-flash,',
        '3) esperar unos minutos y reintentar, o 4) usar Groq/OpenRouter mientras se habilita la cuota.'
      ].join(' ');
    }

    if (responseStatus === 429) {
      return 'Límite de solicitudes alcanzado en Gemini. Espera un minuto y vuelve a intentar.';
    }

    const modelNotFound =
      responseStatus === 404 &&
      (lower.includes('model') && (lower.includes('not found') || lower.includes('not supported')));
    if (modelNotFound) {
      return 'El modelo seleccionado ya no está disponible en Gemini. Prueba con "gemini-flash-latest" o "gemini-pro-latest".';
    }
  }

  if (responseStatus === 429) {
    return 'Límite de requests alcanzado. Espera unos minutos.';
  }

  return msg || `Error HTTP ${responseStatus}`;
}

const PROVIDERS = {
  gemini: {
    buildUrl: (apiKey, model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildBody: (systemPrompt, messages, _model) => ({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: 1024, temperature: 0.6 }
    }),
    extractText: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text,
    wasTruncated: (data) => data.candidates?.[0]?.finishReason === 'MAX_TOKENS',
    buildTestBody: () => ({
      contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      generationConfig: { maxOutputTokens: 5 }
    })
  },

  groq: {
    buildUrl: () => 'https://api.groq.com/openai/v1/chat/completions',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }),
    buildBody: (systemPrompt, messages, model) => ({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_tokens: 1024,
      temperature: 0.6
    }),
    extractText: (data) => data.choices?.[0]?.message?.content,
    wasTruncated: (data) => data.choices?.[0]?.finish_reason === 'length',
    buildTestBody: (model) => ({
      model,
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 5
    })
  },

  openrouter: {
    buildUrl: () => 'https://openrouter.ai/api/v1/chat/completions',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'chrome-extension://interview-assistant',
      'X-Title': 'Interview Assistant AI'
    }),
    buildBody: (systemPrompt, messages, model) => ({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_tokens: 1024,
      temperature: 0.6
    }),
    extractText: (data) => data.choices?.[0]?.message?.content,
    wasTruncated: (data) => data.choices?.[0]?.finish_reason === 'length',
    buildTestBody: (model) => ({
      model,
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 5
    })
  }
};

async function fetchWithRetry(url, options, maxRetries = 3, initialDelayMs = 500) {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      
      const shouldRetry = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (!shouldRetry || attempt === maxRetries) {
        return response;
      }
      
      console.warn(`[background] Intento ${attempt} falló con estado ${response.status}. Reintentando en ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    } catch (err) {
      if (attempt === maxRetries) {
        throw err;
      }
      console.warn(`[background] Intento ${attempt} falló por error de red: ${err.message}. Reintentando en ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

async function handleAISuggestion({ provider, apiKey, model, systemPrompt, messages }) {
  const prov = PROVIDERS[provider] || PROVIDERS.gemini;

  const url = prov.buildUrl(apiKey, model);
  const headers = prov.buildHeaders(apiKey);
  const body = prov.buildBody(systemPrompt, messages, model);
  if (DEBUG_PROMPT_LOGS) {
    const systemChars = String(systemPrompt || '').length;
    const messageChars = (messages || []).reduce((sum, m) => sum + String(m?.content || '').length, 0);
    const approxInputTokens = Math.ceil((systemChars + messageChars) / 4);
    const safeBody = JSON.parse(JSON.stringify(body));

    // Evita exponer API key en logs.
    if (safeBody?.systemInstruction?.parts?.[0]?.text) {
      safeBody.systemInstruction.parts[0].text = safeBody.systemInstruction.parts[0].text.slice(0, 1200);
    }
    if (Array.isArray(safeBody?.contents)) {
      safeBody.contents = safeBody.contents.map((c) => ({
        ...c,
        parts: Array.isArray(c.parts)
          ? c.parts.map((p) => ({ ...p, text: String(p.text || '').slice(0, 1200) }))
          : c.parts
      }));
    }
    if (Array.isArray(safeBody?.messages)) {
      safeBody.messages = safeBody.messages.map((m) => ({
        ...m,
        content: String(m.content || '').slice(0, 1200)
      }));
    }

    console.group('[IA DEBUG] Request');
    console.log('provider:', provider);
    console.log('model:', model);
    console.log('url:', url.split('?')[0]);
    console.log('systemPrompt chars:', systemChars);
    console.log('messages:', Array.isArray(messages) ? messages.length : 0);
    console.log('messages chars:', messageChars);
    console.log('approx input tokens:', approxInputTokens);
    console.log('request body (preview, truncated):', safeBody);
    console.groupEnd();
  }

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const rawMsg = errData.error?.message || '';
    throw new Error(normalizeProviderError(provider, response.status, rawMsg));
  }

  const data = await response.json();
  const text = prov.extractText(data);
  if (!text) throw new Error('Respuesta vacía del modelo');
  const truncated = typeof prov.wasTruncated === 'function' && prov.wasTruncated(data);
  return { text, truncated };
}

/** Orden sugerido en el <select>: alias *-latest, estables 2.5/2.0, resto alfabético. */
const GEMINI_MODEL_LIST_PRIORITY = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
];

function sortGeminiModelsForUi(items) {
  items.sort((a, b) => {
    const ia = GEMINI_MODEL_LIST_PRIORITY.indexOf(a.value);
    const ib = GEMINI_MODEL_LIST_PRIORITY.indexOf(b.value);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label, 'es', { sensitivity: 'base' });
  });
}

/**
 * Lista modelos de la API Gemini que soportan generateContent (misma key que generateContent).
 * Pagina con nextPageToken hasta agotar resultados.
 */
async function listGeminiModels(apiKey) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('Falta API key para listar modelos.');
  }

  const collected = [];
  const seenIds = new Set();
  let pageToken = '';

  for (let page = 0; page < 25; page++) {
    const qs = new URLSearchParams({ key: String(apiKey).trim(), pageSize: '100' });
    if (pageToken) qs.set('pageToken', pageToken);

    const url = `https://generativelanguage.googleapis.com/v1beta/models?${qs}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const rawMsg = data.error?.message || '';
      throw new Error(normalizeProviderError('gemini', response.status, rawMsg));
    }

    const models = data.models || [];
    for (const m of models) {
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) continue;

      const id = String(m.name || '').replace(/^models\//, '').trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const display = (m.displayName && String(m.displayName).trim()) || id;
      collected.push({
        value: id,
        label: display === id ? id : `${display} — ${id}`
      });
    }

    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }

  sortGeminiModelsForUi(collected);
  return collected;
}

/**
 * Excluye modelos que no encajan con chat/completions (Whisper, TTS Orpheus, prompt-guard, etc.).
 * Basado en respuestas reales de api.groq.com/openai/v1/models.
 */
function groqModelExcludedFromChatPicker(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return true;
  if (s.includes('whisper')) return true;
  if (s.includes('orpheus')) return true;
  if (s.includes('prompt-guard')) return true;
  if (s.includes('safeguard')) return true;
  return false;
}

/** Orden sugerido en el <select> (IDs que suelen aparecer en la API Groq). */
const GROQ_MODEL_LIST_PRIORITY = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'moonshotai/kimi-k2-instruct',
  'moonshotai/kimi-k2-instruct-0905',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'groq/compound',
  'groq/compound-mini',
  'allam-2-7b',
];

function sortGroqModelsForUi(items) {
  items.sort((a, b) => {
    const ia = GROQ_MODEL_LIST_PRIORITY.indexOf(a.value);
    const ib = GROQ_MODEL_LIST_PRIORITY.indexOf(b.value);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label, 'es', { sensitivity: 'base' });
  });
}

/**
 * Groq — GET /v1/models; filtra modelos no chat y ordena para la UI.
 */
async function listGroqModels(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Falta API key para listar modelos.');

  const response = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const rawMsg = data.error?.message || data.message || '';
    throw new Error(normalizeProviderError('groq', response.status, rawMsg));
  }

  const rows = data.data || [];
  const seen = new Set();
  const collected = [];

  for (const m of rows) {
    if (m && m.active === false) continue;
    const id = String(m.id || '').trim();
    if (!id || seen.has(id)) continue;
    if (groqModelExcludedFromChatPicker(id)) continue;
    seen.add(id);
    const owned = m.owned_by ? ` (${m.owned_by})` : '';
    collected.push({ value: id, label: `${id}${owned}` });
  }

  sortGroqModelsForUi(collected);
  return collected;
}

function openRouterModelIsFree(m) {
  const id = String(m.id || '').toLowerCase();
  if (id.includes(':free')) return true;

  const pr = m.pricing;
  if (!pr || typeof pr !== 'object') return false;

  const toNum = (v) => {
    if (v === undefined || v === null) return NaN;
    const n = parseFloat(String(v).replace(/^\$/, ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const prompt = toNum(pr.prompt);
  const completion = toNum(pr.completion);
  if (Number.isNaN(prompt) || Number.isNaN(completion)) return false;
  return prompt === 0 && completion === 0;
}

/**
 * OpenRouter — catálogo público; con Bearer se asocia a tu cuenta.
 * onlyFree: por defecto en el popup (evita miles de modelos de pago en el <select>).
 */
async function listOpenRouterModels(apiKey, options = {}) {
  const onlyFree = options.onlyFree !== false;
  const key = String(apiKey || '').trim();

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'HTTP-Referer': 'chrome-extension://interview-assistant',
    'X-Title': 'Interview Assistant AI'
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', { headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const rawMsg = data.error?.message || data.message || '';
    throw new Error(normalizeProviderError('openrouter', response.status, rawMsg));
  }

  const raw = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : [];

  const seen = new Set();
  const collected = [];

  for (const m of raw) {
    const id = String(m.id || '').trim();
    if (!id || seen.has(id)) continue;

    const free = openRouterModelIsFree(m);
    if (onlyFree && !free) continue;

    seen.add(id);
    const name = String(m.name || m.canonical_slug || '').trim();
    const suffix = free ? ' (sin coste)' : '';
    const label = name && name !== id ? `${name} — ${id}${suffix}` : `${id}${suffix}`;
    collected.push({ value: id, label });
  }

  collected.sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
  return collected;
}

async function testApiKey(provider, apiKey, model) {
  const prov = PROVIDERS[provider] || PROVIDERS.gemini;
  const url = prov.buildUrl(apiKey, model);
  const headers = prov.buildHeaders(apiKey);
  const body = prov.buildTestBody(model);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const rawMsg = err.error?.message || '';
    throw new Error(normalizeProviderError(provider, response.status, rawMsg));
  }
}

function extractJsonObjectsFromBuffer(bufferStr) {
  const objects = [];
  let braceCount = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < bufferStr.length; i++) {
    const char = bufferStr[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        if (braceCount === 0) {
          startIdx = i;
        }
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && startIdx !== -1) {
          objects.push(bufferStr.slice(startIdx, i + 1));
          startIdx = -1;
        }
      }
    }
  }

  const remaining = startIdx !== -1 ? bufferStr.slice(startIdx) : '';
  return { objects, remaining };
}

async function handleAISuggestionStream({ provider, apiKey, model, systemPrompt, messages }, port) {
  const prov = PROVIDERS[provider] || PROVIDERS.gemini;

  let url = prov.buildUrl(apiKey, model);
  if (provider === 'gemini') {
    url = url.replace(':generateContent', ':streamGenerateContent');
  }

  const headers = prov.buildHeaders(apiKey);
  const body = prov.buildBody(systemPrompt, messages, model);

  if (provider === 'groq' || provider === 'openrouter') {
    body.stream = true;
  }

  if (DEBUG_PROMPT_LOGS) {
    console.group('[IA DEBUG] Stream Request');
    console.log('provider:', provider);
    console.log('model:', model);
    console.log('url:', url.split('?')[0]);
    console.groupEnd();
  }

  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const rawMsg = errData.error?.message || errData.message || '';
      throw new Error(normalizeProviderError(provider, response.status, rawMsg));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (provider === 'gemini') {
        const { objects, remaining } = extractJsonObjectsFromBuffer(buffer);
        buffer = remaining;
        for (const jsonStr of objects) {
          try {
            const parsed = JSON.parse(jsonStr);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) {
              port.postMessage({ type: 'chunk', text });
            }
          } catch (e) {
            console.warn('[background] Error al parsear chunk de Gemini:', e);
          }
        }
      } else {
        let lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const cleaned = line.trim();
          if (!cleaned) continue;
          if (cleaned.startsWith('data: ')) {
            const dataStr = cleaned.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const text = parsed.choices?.[0]?.delta?.content || '';
              if (text) {
                port.postMessage({ type: 'chunk', text });
              }
            } catch (e) {
              console.warn('[background] Error al parsear SSE chunk:', e);
            }
          }
        }
      }
    }

    if (buffer && (provider === 'groq' || provider === 'openrouter')) {
      const cleaned = buffer.trim();
      if (cleaned.startsWith('data: ') && !cleaned.includes('[DONE]')) {
        try {
          const parsed = JSON.parse(cleaned.slice(6));
          const text = parsed.choices?.[0]?.delta?.content || '';
          if (text) {
            port.postMessage({ type: 'chunk', text });
          }
        } catch (err) {
          console.warn('[background] Error parsing residual SSE:', err);
        }
      }
    }

    port.postMessage({ type: 'done' });

  } catch (err) {
    console.error('[background] Error en stream:', err);
    port.postMessage({ type: 'error', error: err.message });
  }
}


