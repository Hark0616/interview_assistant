// background.js — Service Worker
// Soporte multi-proveedor: Gemini, Groq, OpenRouter
// La gestión del panel pop-out vive en panelManager.js (importScripts).

importScripts('panelManager.js');
const DEBUG_PROMPT_LOGS = true;
const AI_REQUEST_TIMEOUT_MS = 60000;
const AI_STREAM_FIRST_TOKEN_TIMEOUT_MS = 20000;
const AI_STREAM_INACTIVITY_TIMEOUT_MS = 15000;
const AI_STREAM_TOTAL_TIMEOUT_MS = 90000;
const DEFAULT_MAX_COMPLETION_TOKENS = 512;

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
      .then(result => sendResponse({
        success: true,
        suggestion: result.text,
        truncated: result.truncated,
        usage: result.usage
      }))
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
  if (port.name !== 'ai-stream') return;

  let activeRequest = null;

  function clearRequestTimers(requestRef) {
    if (!requestRef) return;
    clearTimeout(requestRef.firstTokenTimeoutId);
    clearTimeout(requestRef.inactivityTimeoutId);
    clearTimeout(requestRef.totalTimeoutId);
  }

  function cancelActiveRequest(reason = 'Solicitud cancelada.') {
    if (!activeRequest) return;
    clearRequestTimers(activeRequest);
    activeRequest.controller.abort(new Error(reason));
    activeRequest = null;
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === 'CANCEL_AI_SUGGESTION_STREAM') {
      cancelActiveRequest();
      return;
    }

    if (msg.type !== 'GET_AI_SUGGESTION_STREAM') return;

    cancelActiveRequest('Solicitud reemplazada por una petición nueva.');
    const controller = new globalThis.AbortController();
    const requestRef = {
      controller,
      firstTokenReceived: false,
      firstTokenTimeoutId: null,
      inactivityTimeoutId: null,
      totalTimeoutId: null,
      markActivity(hasContent = false) {
        if (hasContent && !this.firstTokenReceived) {
          this.firstTokenReceived = true;
          clearTimeout(this.firstTokenTimeoutId);
          this.firstTokenTimeoutId = null;
        }
        clearTimeout(this.inactivityTimeoutId);
        this.inactivityTimeoutId = setTimeout(() => {
          controller.abort(new Error(
            `La IA no envió datos durante ${AI_STREAM_INACTIVITY_TIMEOUT_MS / 1000} segundos.`
          ));
        }, AI_STREAM_INACTIVITY_TIMEOUT_MS);
      }
    };
    requestRef.firstTokenTimeoutId = setTimeout(() => {
      controller.abort(new Error(
        `La IA no comenzó a responder en ${AI_STREAM_FIRST_TOKEN_TIMEOUT_MS / 1000} segundos.`
      ));
    }, AI_STREAM_FIRST_TOKEN_TIMEOUT_MS);
    requestRef.totalTimeoutId = setTimeout(() => {
      controller.abort(new Error(
        `La respuesta superó el límite total de ${AI_STREAM_TOTAL_TIMEOUT_MS / 1000} segundos.`
      ));
    }, AI_STREAM_TOTAL_TIMEOUT_MS);
    activeRequest = requestRef;

    handleAISuggestionStream(msg.data, port, requestRef).finally(() => {
      clearRequestTimers(requestRef);
      if (activeRequest === requestRef) activeRequest = null;
    });
  });

  port.onDisconnect.addListener(() => {
    cancelActiveRequest('El panel cerró la conexión con la IA.');
  });
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
    buildBody: (systemPrompt, messages, _model, options = {}) => ({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: {
        maxOutputTokens: options.maxCompletionTokens || DEFAULT_MAX_COMPLETION_TOKENS,
        temperature: options.temperature ?? 0.4
      }
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
    buildBody: (systemPrompt, messages, model, options = {}) => ({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_tokens: options.maxCompletionTokens || DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: options.temperature ?? 0.4
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
      'X-OpenRouter-Title': 'Interview Assistant AI'
    }),
    buildBody: (systemPrompt, messages, model, options = {}) => {
      const systemContent = String(model || '').startsWith('anthropic/')
        ? [{
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral', ttl: '1h' }
          }]
        : systemPrompt;
      const body = {
        model,
        messages: [
          { role: 'system', content: systemContent },
          ...messages
        ],
        max_completion_tokens: options.maxCompletionTokens || DEFAULT_MAX_COMPLETION_TOKENS,
        temperature: options.temperature ?? 0.4
      };
      if (options.sessionId) body.session_id = options.sessionId;
      if (options.routing && options.routing !== 'balanced') {
        body.provider = {
          sort: options.routing === 'price' ? 'price' : 'latency',
          allow_fallbacks: true
        };
      }
      if (options.reasoningEffort && options.reasoningEffort !== 'none') {
        body.reasoning = { effort: options.reasoningEffort };
      }
      return body;
    },
    extractText: (data) => data.choices?.[0]?.message?.content,
    wasTruncated: (data) => data.choices?.[0]?.finish_reason === 'length',
    buildTestBody: (model) => ({
      model,
      messages: [{ role: 'user', content: 'test' }],
      max_completion_tokens: 5
    })
  }
};

function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const promptDetails = rawUsage.prompt_tokens_details || rawUsage.promptTokensDetails || {};
  const completionDetails = rawUsage.completion_tokens_details || rawUsage.completionTokensDetails || {};
  const value = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  return {
    promptTokens: value(rawUsage.prompt_tokens ?? rawUsage.promptTokens),
    completionTokens: value(rawUsage.completion_tokens ?? rawUsage.completionTokens),
    reasoningTokens: value(
      rawUsage.reasoning_tokens ?? rawUsage.reasoningTokens ??
      completionDetails.reasoning_tokens ?? completionDetails.reasoningTokens
    ),
    cachedTokens: value(
      rawUsage.cached_tokens ?? rawUsage.cachedTokens ??
      promptDetails.cached_tokens ?? promptDetails.cachedTokens
    ),
    cacheWriteTokens: value(
      rawUsage.cache_write_tokens ?? rawUsage.cacheWriteTokens ??
      promptDetails.cache_write_tokens ?? promptDetails.cacheWriteTokens
    ),
    cost: value(rawUsage.cost)
  };
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(signal.reason?.message || 'Solicitud cancelada.'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getRetryDelayMs(response, fallbackMs) {
  const raw = response?.headers?.get?.('Retry-After');
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(raw);
  if (!Number.isNaN(retryAt)) return Math.max(0, retryAt - Date.now());
  return fallbackMs;
}

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
      
      const retryDelay = getRetryDelayMs(response, delay);
      console.warn(`[background] Intento ${attempt} falló con estado ${response.status}. Reintentando en ${retryDelay}ms...`);
      await waitForRetry(retryDelay, options?.signal);
      delay = Math.max(delay * 2, retryDelay);
    } catch (err) {
      if (options?.signal?.aborted) {
        throw new Error(options.signal.reason?.message || 'Solicitud cancelada.');
      }
      if (attempt === maxRetries) {
        throw err;
      }
      console.warn(`[background] Intento ${attempt} falló por error de red: ${err.message}. Reintentando en ${delay}ms...`);
      await waitForRetry(delay, options?.signal);
      delay *= 2;
    }
  }
}

function buildRequestOptions(data = {}) {
  const requestedMax = Number(data.maxCompletionTokens) || DEFAULT_MAX_COMPLETION_TOKENS;
  const modelMax = Number(data.modelMetadata?.maxCompletionTokens);
  return {
    maxCompletionTokens: Number.isFinite(modelMax) && modelMax > 0
      ? Math.min(requestedMax, modelMax)
      : requestedMax,
    temperature: data.temperature,
    sessionId: data.meetingSessionId,
    routing: data.openRouterRouting || 'balanced',
    reasoningEffort: data.reasoningEffort || 'none'
  };
}

function validateApproximateContext(systemPrompt, messages, modelMetadata, maxCompletionTokens) {
  const contextLength = Number(modelMetadata?.contextLength);
  if (!Number.isFinite(contextLength) || contextLength <= 0) return;
  const chars = String(systemPrompt || '').length + (messages || [])
    .reduce((sum, item) => sum + String(item?.content || '').length, 0);
  const approximateInputTokens = Math.ceil(chars / 4);
  if (approximateInputTokens + maxCompletionTokens > Math.floor(contextLength * 0.95)) {
    throw new Error(
      `El contexto estimado (${approximateInputTokens.toLocaleString('es')} tokens) no cabe en ` +
      `el modelo seleccionado (${contextLength.toLocaleString('es')} tokens). Reduce el contexto o cambia de modelo.`
    );
  }
}

async function handleAISuggestion(requestData) {
  const { provider, apiKey, model, systemPrompt, messages, modelMetadata } = requestData;
  const prov = PROVIDERS[provider] || PROVIDERS.gemini;
  const controller = new globalThis.AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`La IA tardó más de ${AI_REQUEST_TIMEOUT_MS / 1000} segundos.`));
  }, AI_REQUEST_TIMEOUT_MS);

  const url = prov.buildUrl(apiKey, model);
  const headers = prov.buildHeaders(apiKey);
  const requestOptions = buildRequestOptions(requestData);
  validateApproximateContext(systemPrompt, messages, modelMetadata, requestOptions.maxCompletionTokens);
  const body = prov.buildBody(systemPrompt, messages, model, requestOptions);
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

  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const rawMsg = errData.error?.message || '';
      throw new Error(normalizeProviderError(provider, response.status, rawMsg));
    }

    const responseData = await response.json();
    const text = prov.extractText(responseData);
    if (!text) throw new Error('Respuesta vacía del modelo');
    const truncated = typeof prov.wasTruncated === 'function' && prov.wasTruncated(responseData);
    return { text, truncated, usage: normalizeUsage(responseData.usage) };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(controller.signal.reason?.message || 'Solicitud cancelada.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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

function formatContextLength(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`;
  return `${Math.round(value / 1000)}K`;
}

function formatPerMillion(rawPrice) {
  const value = Number(rawPrice);
  if (!Number.isFinite(value) || value < 0) return '';
  const perMillion = value * 1000000;
  return `$${perMillion < 0.01 ? perMillion.toFixed(4) : perMillion.toFixed(2)}`;
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
    'X-OpenRouter-Title': 'Interview Assistant AI'
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
    const contextLength = Number(m.context_length) || null;
    const maxCompletionTokens = Number(m.top_provider?.max_completion_tokens) || null;
    const inputPrice = formatPerMillion(m.pricing?.prompt);
    const outputPrice = formatPerMillion(m.pricing?.completion);
    const details = free ? ['sin coste'] : [];
    if (contextLength) details.push(`${formatContextLength(contextLength)} contexto`);
    if (inputPrice && outputPrice) details.push(`${inputPrice}/${outputPrice} por M`);
    const suffix = details.join(' · ');
    const baseLabel = name && name !== id ? `${name} — ${id}` : id;
    const label = suffix ? `${baseLabel} (${suffix})` : baseLabel;
    collected.push({
      value: id,
      label,
      metadata: {
        contextLength,
        maxCompletionTokens,
        pricing: {
          prompt: m.pricing?.prompt ?? null,
          completion: m.pricing?.completion ?? null
        },
        supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : []
      }
    });
  }

  collected.sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
  return collected;
}

async function testApiKey(provider, apiKey, model) {
  if (provider === 'openrouter') {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'chrome-extension://interview-assistant',
        'X-OpenRouter-Title': 'Interview Assistant AI'
      }
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const rawMsg = err.error?.message || err.message || '';
      throw new Error(normalizeProviderError(provider, response.status, rawMsg));
    }
    return;
  }

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

function postPortMessage(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function createStreamingProviderError(parsedError) {
  const type = parsedError?.metadata?.error_type || parsedError?.code || 'stream_error';
  const message = parsedError?.message || parsedError?.metadata?.raw || 'Error del proveedor durante streaming.';
  const error = new Error(`${message} (${type})`);
  error.isProviderStreamError = true;
  return error;
}

async function handleAISuggestionStream(requestData, port, requestRef) {
  const {
    provider, apiKey, model, systemPrompt, messages, modelMetadata
  } = requestData;
  const prov = PROVIDERS[provider] || PROVIDERS.gemini;
  const signal = requestRef.controller.signal;

  let url = prov.buildUrl(apiKey, model);
  if (provider === 'gemini') {
    url = url.replace(':generateContent', ':streamGenerateContent');
  }

  const headers = prov.buildHeaders(apiKey);
  const requestOptions = buildRequestOptions(requestData);
  try {
    validateApproximateContext(systemPrompt, messages, modelMetadata, requestOptions.maxCompletionTokens);
  } catch (err) {
    postPortMessage(port, { type: 'error', error: err.message, partial: false });
    return;
  }
  const body = prov.buildBody(systemPrompt, messages, model, requestOptions);

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

  let receivedText = false;
  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const rawMsg = errData.error?.message || errData.message || '';
      throw new Error(normalizeProviderError(provider, response.status, rawMsg));
    }

    requestRef.markActivity(false);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let truncated = false;
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      requestRef.markActivity(false);

      buffer += decoder.decode(value, { stream: true });

      if (provider === 'gemini') {
        const { objects, remaining } = extractJsonObjectsFromBuffer(buffer);
        buffer = remaining;
        for (const jsonStr of objects) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.error) throw createStreamingProviderError(parsed.error);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (parsed.candidates?.[0]?.finishReason === 'MAX_TOKENS') truncated = true;
            if (text) {
              receivedText = true;
              requestRef.markActivity(true);
              postPortMessage(port, { type: 'chunk', text });
            }
          } catch (e) {
            if (e.isProviderStreamError) throw e;
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
              if (parsed.error) throw createStreamingProviderError(parsed.error);
              if (parsed.usage) usage = normalizeUsage(parsed.usage);
              const text = parsed.choices?.[0]?.delta?.content || '';
              if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true;
              if (text) {
                receivedText = true;
                requestRef.markActivity(true);
                postPortMessage(port, { type: 'chunk', text });
              }
            } catch (e) {
              if (e.isProviderStreamError) throw e;
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
          if (parsed.error) throw createStreamingProviderError(parsed.error);
          if (parsed.usage) usage = normalizeUsage(parsed.usage);
          const text = parsed.choices?.[0]?.delta?.content || '';
          if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true;
          if (text) {
            receivedText = true;
            requestRef.markActivity(true);
            postPortMessage(port, { type: 'chunk', text });
          }
        } catch (err) {
          if (err.isProviderStreamError) throw err;
          console.warn('[background] Error parsing residual SSE:', err);
        }
      }
    }

    postPortMessage(port, { type: 'done', truncated, usage });

  } catch (err) {
    const abortMessage = String(signal?.reason?.message || '');
    const wasExplicitCancellation = signal?.aborted && (
      abortMessage.includes('Solicitud cancelada') ||
      abortMessage.includes('Solicitud reemplazada') ||
      abortMessage.includes('panel cerró')
    );
    if (wasExplicitCancellation) return;
    const errorMessage = signal?.aborted
      ? (signal.reason?.message || err.message)
      : err.message;
    console.error('[background] Error en stream:', errorMessage);
    postPortMessage(port, { type: 'error', error: errorMessage, partial: receivedText });
  }
}
