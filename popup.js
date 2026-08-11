// popup.js — Listas de modelos desde API (Gemini, Groq, OpenRouter) vía background
//
// Fallbacks Gemini: alineados con la respuesta real de list models (generateContent).
// Incluye alias *-latest que devuelve la API. Fuente de verdad: botón Actualizar.
const GEMINI_FALLBACK_MODELS = [
  { value: 'gemini-flash-latest', label: 'gemini-flash-latest (alias → último Flash)' },
  { value: 'gemini-flash-lite-latest', label: 'gemini-flash-lite-latest (alias → último Flash-Lite)' },
  { value: 'gemini-pro-latest', label: 'gemini-pro-latest (alias → último Pro)' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (estable)' },
  { value: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite (estable, rápido)' },
];

// Fallback Groq: IDs reales típicos de GET /v1/models (marzo 2026). Actualizar lista el catálogo actual.
const GROQ_FALLBACK_MODELS = [
  { value: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant (rápido)' },
  { value: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile (calidad)' },
  { value: 'qwen/qwen3-32b', label: 'qwen/qwen3-32b' },
];

// Fallback OpenRouter: solo si falla el catálogo — openrouter.ai/models
const OPENROUTER_FALLBACK_MODELS = [
  { value: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama 3.1 8B :free (fallback)' },
  { value: 'google/gemini-2.0-flash-lite-001', label: 'Gemini 2.0 Flash Lite (fallback)' },
  { value: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B :free (fallback)' },
];

const HINTS = {
  gemini:
    'Gratis en <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com</a> → Get API Key. Lista real de tu proyecto: botón Actualizar. Modelos/nombres oficiales: <a href="https://ai.google.dev/gemini-api/docs/models" target="_blank">documentación Gemini</a>.',
  groq:
    'Gratis en <a href="https://console.groq.com" target="_blank">console.groq.com</a> → API Keys. Lista real con Actualizar (GET /openai/v1/models).',
  openrouter:
    'Clave en <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>. Catálogo: Actualizar (GET /api/v1/models). Ver también <a href="https://openrouter.ai/models" target="_blank">openrouter.ai/models</a>.',
};

function fallbackModels(provider) {
  if (provider === 'gemini') return GEMINI_FALLBACK_MODELS;
  if (provider === 'groq') return GROQ_FALLBACK_MODELS;
  if (provider === 'openrouter') return OPENROUTER_FALLBACK_MODELS;
  return GROQ_FALLBACK_MODELS;
}

document.addEventListener('DOMContentLoaded', () => {
  const footerVer = document.getElementById('footer-version');
  if (footerVer) {
    try {
      footerVer.textContent = 'v' + (chrome.runtime.getManifest()?.version || '');
    } catch {
      footerVer.textContent = '';
    }
  }

  let resultFadeTimer = null;
  let resultFadeFallback = null;

  /** null = aún no cargado desde API para ese proveedor */
  const modelsFromApi = { gemini: null, groq: null, openrouter: null };

  /** API keys guardadas por proveedor { gemini: '', groq: '', openrouter: '' } */
  let apiKeys = { gemini: '', groq: '', openrouter: '' };

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  const providerSelect = document.getElementById('provider');
  const modelSelect = document.getElementById('model');
  const memoryModelSelect = document.getElementById('memoryModel');
  const apiKeyInput = document.getElementById('apiKey');
  const hintEl = document.getElementById('api-hint');
  const modelHintEl = document.getElementById('model-hint');
  const refreshModelsBtn = document.getElementById('refresh-models-btn');
  const openrouterFreeRow = document.getElementById('openrouter-free-row');
  const openrouterFreeOnly = document.getElementById('openrouter-free-only');
  const openrouterRoutingRow = document.getElementById('openrouter-routing-row');
  const openrouterReasoningRow = document.getElementById('openrouter-reasoning-row');
  let savedConfig = {};

  function openRouterOnlyFree() {
    return openrouterFreeOnly ? openrouterFreeOnly.checked !== false : true;
  }

  function persistOpenRouterFilter() {
    chrome.storage.local.get(['iaConfig'], (r) => {
      const merged = { ...(r.iaConfig || {}), openRouterOnlyFree: openRouterOnlyFree() };
      chrome.storage.local.set({ iaConfig: merged });
    });
  }

  function storeCurrentKeyForProvider() {
    const p = providerSelect.value;
    apiKeys[p] = getValue('apiKey');
  }

  function restoreKeyForProvider(provider) {
    setValue('apiKey', apiKeys[provider] || '');
  }

  apiKeyInput.addEventListener('input', storeCurrentKeyForProvider);

  function fillModelSelect(select, models, preferredValue) {
    select.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      if (m.metadata) opt.dataset.metadata = JSON.stringify(m.metadata);
      select.appendChild(opt);
    }
    const want = preferredValue || '';
    if (want && [...select.options].some((o) => o.value === want)) {
      select.value = want;
    }
  }

  function fillMemoryModelSelect(models, preferredValue) {
    memoryModelSelect.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Usar modelo principal';
    memoryModelSelect.appendChild(defaultOption);
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.value;
      option.textContent = model.label;
      if (model.metadata) option.dataset.metadata = JSON.stringify(model.metadata);
      memoryModelSelect.appendChild(option);
    }
    if (preferredValue && [...memoryModelSelect.options].some((option) => option.value === preferredValue)) {
      memoryModelSelect.value = preferredValue;
    }
  }

  function updateModelHint(provider) {
    if (!modelHintEl) return;
    const n = modelsFromApi[provider]?.length;
    if (provider === 'gemini') {
      modelHintEl.textContent = n
        ? `Gemini: ${n} modelos (generateContent). Usa Actualizar para refrescar.`
        : 'Gemini: pulsa Actualizar con tu key (también al abrir si ya está guardada).';
    } else if (provider === 'groq') {
      modelHintEl.textContent = n
        ? `Groq: ${n} modelos desde la API. Usa Actualizar para refrescar.`
        : 'Groq: pulsa Actualizar con tu key para listar modelos disponibles para tu cuenta.';
    } else {
      modelHintEl.textContent = n
        ? `OpenRouter: ${n} modelos${openRouterOnlyFree() ? ' (solo sin coste)' : ' (catálogo completo)'}. Usa Actualizar para refrescar.`
        : 'OpenRouter: pulsa Actualizar para cargar el catálogo. Opcional: filtrar solo sin coste.';
    }
  }

  function updateModels(provider, preferredModel) {
    const prev =
      preferredModel !== undefined && preferredModel !== null && preferredModel !== ''
        ? preferredModel
        : modelSelect.value;

    hintEl.innerHTML = HINTS[provider] || '';

    refreshModelsBtn.style.display = '';

    if (openrouterFreeRow) {
      openrouterFreeRow.style.display = provider === 'openrouter' ? 'flex' : 'none';
    }
    if (openrouterRoutingRow) {
      openrouterRoutingRow.style.display = provider === 'openrouter' ? 'block' : 'none';
    }
    if (openrouterReasoningRow) {
      openrouterReasoningRow.style.display = provider === 'openrouter' ? 'block' : 'none';
    }

    const list =
      modelsFromApi[provider] && modelsFromApi[provider].length
        ? modelsFromApi[provider]
        : fallbackModels(provider);

    fillModelSelect(modelSelect, list, prev);
    const preferredMemory = savedConfig.provider === provider
      ? (memoryModelSelect.value || savedConfig.memoryModel || '')
      : '';
    fillMemoryModelSelect(list, preferredMemory);
    updateModelHint(provider);
  }

  function fetchModelsFromApi(provider, apiKey, preserveModelId) {
    const preferred = preserveModelId !== undefined ? preserveModelId : modelSelect.value;

    const needsKey = provider === 'gemini' || provider === 'groq';
    if (needsKey && !apiKey) {
      modelsFromApi[provider] = null;
      updateModels(provider, preferred);
      showResult('test-result', 'Ingresa API key y pulsa Actualizar', 'error');
      return;
    }

    modelSelect.disabled = true;
    refreshModelsBtn.disabled = true;
    const prevLabel = refreshModelsBtn.textContent;
    refreshModelsBtn.textContent = '...';

    const payload = {
      type: 'LIST_PROVIDER_MODELS',
      provider,
      apiKey: apiKey || '',
      openRouterOnlyFree: provider === 'openrouter' ? openRouterOnlyFree() : undefined,
    };

    chrome.runtime.sendMessage(payload, (response) => {
      modelSelect.disabled = false;
      refreshModelsBtn.disabled = false;
      refreshModelsBtn.textContent = prevLabel;

      if (chrome.runtime?.lastError) {
        modelsFromApi[provider] = null;
        updateModels(provider, preferred);
        showResult('test-result', `Error: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }

      if (response?.success && Array.isArray(response.models) && response.models.length > 0) {
        modelsFromApi[provider] = response.models;
        updateModels(provider, preferred);
        return;
      }

      modelsFromApi[provider] = null;
      updateModels(provider, preferred);
      let err = response?.error || 'No se obtuvieron modelos';
      if (
        provider === 'openrouter' &&
        openRouterOnlyFree() &&
        (!response?.models || response.models.length === 0)
      ) {
        err +=
          ' Prueba a desmarcar «solo sin coste» para ver el catálogo completo.';
      }
      showResult('test-result', `Error: ${err} (lista de respaldo)`, 'error');
    });
  }

  providerSelect.addEventListener('change', () => {
    const p = providerSelect.value;
    memoryModelSelect.value = '';
    restoreKeyForProvider(p);
    updateModels(p);
    const key = getValue('apiKey');
    if (p === 'openrouter') {
      fetchModelsFromApi(p, key, modelSelect.value);
    } else if (key) {
      fetchModelsFromApi(p, key, modelSelect.value);
    }
  });

  refreshModelsBtn.addEventListener('click', () => {
    fetchModelsFromApi(providerSelect.value, getValue('apiKey'), modelSelect.value);
  });

  if (openrouterFreeOnly) {
    openrouterFreeOnly.addEventListener('change', () => {
      persistOpenRouterFilter();
      if (providerSelect.value === 'openrouter') {
        fetchModelsFromApi('openrouter', getValue('apiKey'), modelSelect.value);
      }
    });
  }

  chrome.storage.local.get(['iaConfig'], (result) => {
    const cfg = result.iaConfig;
    if (!cfg) {
      updateModels('gemini');
      return;
    }
    savedConfig = cfg;

    const savedKeys = cfg.apiKeys || {};
    apiKeys.gemini = savedKeys.gemini || '';
    apiKeys.groq = savedKeys.groq || '';
    apiKeys.openrouter = savedKeys.openrouter || '';

    // Migración: si hay una apiKey antigua sin apiKeys, asignarla al proveedor guardado
    if (cfg.apiKey && !savedKeys[cfg.provider || 'gemini']) {
      apiKeys[cfg.provider || 'gemini'] = cfg.apiKey;
    }

    const p = cfg.provider || 'gemini';
    providerSelect.value = p;
    if (openrouterFreeOnly && cfg.openRouterOnlyFree === false) {
      openrouterFreeOnly.checked = false;
    }
    updateModels(p, cfg.model);
    if (cfg.model && [...modelSelect.options].some((o) => o.value === cfg.model)) {
      modelSelect.value = cfg.model;
    }
    if (cfg.memoryModel && [...memoryModelSelect.options].some((o) => o.value === cfg.memoryModel)) {
      memoryModelSelect.value = cfg.memoryModel;
    }
    restoreKeyForProvider(p);
    setValue('myName', cfg.myName || '');
    setValue('cvProfile', cfg.cvProfile || '');
    setValue('jobDescription', cfg.jobDescription || '');
    setValue('company', cfg.company || '');
    setValue('vaultUrl', cfg.vaultUrl || 'http://127.0.0.1:3847');
    setValue('vaultToken', cfg.vaultToken || '');
    setValue('openRouterRouting', cfg.openRouterRouting || 'latency');
    setValue('reasoningEffort', cfg.reasoningEffort || 'none');

    const key = apiKeys[p] || '';
    if (p === 'openrouter') {
      fetchModelsFromApi('openrouter', key, cfg.model);
    } else if (key) {
      fetchModelsFromApi(p, key, cfg.model);
    }
  });

  document.getElementById('test-btn').addEventListener('click', () => {
    const apiKey = getValue('apiKey');
    const provider = providerSelect.value;
    if (!apiKey) return showResult('test-result', 'Ingresa una API Key primero', 'error');

    const btn = document.getElementById('test-btn');
    btn.textContent = '...';
    btn.disabled = true;

    const model = modelSelect.value;
    chrome.runtime.sendMessage({ type: 'TEST_API_KEY', provider, apiKey, model }, (response) => {
      btn.textContent = 'Probar';
      btn.disabled = false;
      if (response?.success) {
        showResult('test-result', 'Conexión correcta', 'success');
        fetchModelsFromApi(provider, apiKey, model);
      } else {
        showResult('test-result', `Error: ${response?.error || 'desconocido'}`, 'error');
      }
    });
  });

  function buildVaultEndpoint(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    u = u.replace(/\/$/, '');
    if (!/\/v1\/api-keys$/i.test(u)) u += '/v1/api-keys';
    return u;
  }

  async function vaultPull() {
    const url = buildVaultEndpoint(getValue('vaultUrl'));
    const token = getValue('vaultToken');
    if (!url) return showResult('vault-result', 'Indica la URL del cofre', 'error', { autoFade: false });
    if (!token) return showResult('vault-result', 'Indica el token (IA_VAULT_TOKEN)', 'error', { autoFade: false });
    showResult('vault-result', 'Descargando…', 'info', { autoFade: false });
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return showResult('vault-result', `Error ${res.status}: ${data.error || res.statusText}`, 'error', { autoFade: false });
      }
      if (!data.apiKeys || typeof data.apiKeys !== 'object') {
        return showResult('vault-result', 'Respuesta inválida (falta apiKeys)', 'error', { autoFade: false });
      }
      apiKeys.gemini = String(data.apiKeys.gemini || '');
      apiKeys.groq = String(data.apiKeys.groq || '');
      apiKeys.openrouter = String(data.apiKeys.openrouter || '');
      restoreKeyForProvider(providerSelect.value);
      chrome.storage.local.get(['iaConfig'], (existing) => {
        const merged = {
          ...(existing.iaConfig || {}),
          apiKeys: { ...apiKeys },
          apiKey: apiKeys[providerSelect.value] || existing.iaConfig?.apiKey || '',
          vaultUrl: getValue('vaultUrl') || 'http://127.0.0.1:3847',
          vaultToken: getValue('vaultToken'),
        };
        chrome.storage.local.set({ iaConfig: merged });
      });
      showResult('vault-result', 'Claves traídas y guardadas en la extensión', 'success', { autoFade: false });
    } catch (e) {
      showResult('vault-result', `Red: ${e.message || '¿Servidor encendido?'}`, 'error', { autoFade: false });
    }
  }

  async function vaultPush() {
    const url = buildVaultEndpoint(getValue('vaultUrl'));
    const token = getValue('vaultToken');
    if (!url) return showResult('vault-result', 'Indica la URL del cofre', 'error', { autoFade: false });
    if (!token) return showResult('vault-result', 'Indica el token', 'error', { autoFade: false });
    storeCurrentKeyForProvider();
    showResult('vault-result', 'Subiendo…', 'info', { autoFade: false });
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'omit',
        body: JSON.stringify({
          apiKeys: {
            gemini: apiKeys.gemini || '',
            groq: apiKeys.groq || '',
            openrouter: apiKeys.openrouter || '',
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return showResult('vault-result', `Error ${res.status}: ${data.error || res.statusText}`, 'error', { autoFade: false });
      }
      showResult('vault-result', 'Claves guardadas en el archivo del cofre', 'success', { autoFade: false });
    } catch (e) {
      showResult('vault-result', `Red: ${e.message || '¿Servidor encendido?'}`, 'error', { autoFade: false });
    }
  }

  document.getElementById('vault-pull-btn')?.addEventListener('click', () => { vaultPull(); });
  document.getElementById('vault-push-btn')?.addEventListener('click', () => { vaultPush(); });

  document.getElementById('save-btn').addEventListener('click', () => {
    const provider = providerSelect.value;
    storeCurrentKeyForProvider();
    const apiKey = apiKeys[provider] || '';
    if (!apiKey) return showResult('save-result', 'Ingresa una API Key para continuar', 'error');

    chrome.storage.local.get(['iaConfig'], (existing) => {
      const selectedOption = modelSelect.selectedOptions?.[0];
      let modelMetadata = null;
      try {
        modelMetadata = selectedOption?.dataset?.metadata
          ? JSON.parse(selectedOption.dataset.metadata)
          : null;
      } catch {
        modelMetadata = null;
      }
      if (!modelMetadata && savedConfig.model === modelSelect.value) {
        modelMetadata = savedConfig.modelMetadata || null;
      }
      const memoryModel = memoryModelSelect.value || '';
      const memoryOption = memoryModelSelect.selectedOptions?.[0];
      let memoryModelMetadata = null;
      try {
        memoryModelMetadata = memoryOption?.dataset?.metadata
          ? JSON.parse(memoryOption.dataset.metadata)
          : null;
      } catch {
        memoryModelMetadata = null;
      }
      if (!memoryModelMetadata && memoryModel && savedConfig.memoryModel === memoryModel) {
        memoryModelMetadata = savedConfig.memoryModelMetadata || null;
      }
      const merged = {
        ...(existing.iaConfig || {}),
        provider,
        apiKey,
        apiKeys: { ...apiKeys },
        model: modelSelect.value,
        modelMetadata,
        memoryModel,
        memoryModelMetadata,
        myName: getValue('myName'),
        cvProfile: getValue('cvProfile'),
        jobDescription: getValue('jobDescription'),
        company: getValue('company'),
        openRouterOnlyFree: openRouterOnlyFree(),
        openRouterRouting: getValue('openRouterRouting') || 'latency',
        reasoningEffort: getValue('reasoningEffort') || 'none',
        vaultUrl: getValue('vaultUrl') || 'http://127.0.0.1:3847',
        vaultToken: getValue('vaultToken'),
      };
      chrome.storage.local.set({ iaConfig: merged }, () => {
        savedConfig = merged;
        showResult('save-result', 'Configuración guardada', 'success');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          let isSupportedMeetingTab = false;
          try {
            const host = new URL(tab?.url || '').hostname;
            isSupportedMeetingTab = host === 'meet.google.com'
              || host === 'teams.microsoft.com'
              || host === 'teams.live.com'
              || host === 'teams.cloud.microsoft'
              || host.endsWith('.teams.microsoft.com')
              || host.endsWith('.teams.cloud.microsoft');
          } catch {
            isSupportedMeetingTab = false;
          }
          if (tab?.id != null && isSupportedMeetingTab) {
            chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED' }).catch(() => {});
          }
        });
      });
    });
  });

  function getValue(id) {
    return document.getElementById(id)?.value?.trim() || '';
  }
  function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
  function showResult(id, msg, type, opts = {}) {
    const el = document.getElementById(id);
    if (!el) return;

    if (resultFadeTimer) clearTimeout(resultFadeTimer);
    if (resultFadeFallback) clearTimeout(resultFadeFallback);
    resultFadeTimer = null;
    resultFadeFallback = null;

    el.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = `alert alert-${type} alert-animate`;
    inner.style.display = 'block';
    inner.textContent = msg;
    el.appendChild(inner);

    const autoFadeSuccess = type === 'success' && opts.autoFade !== false;
    if (!autoFadeSuccess) return;

    const visibleMs = typeof opts.visibleMs === 'number' ? opts.visibleMs : 2200;
    const fadeMs = 450;

    resultFadeTimer = setTimeout(() => {
      inner.style.opacity = '0';
      const finish = () => {
        inner.removeEventListener('transitionend', onTransEnd);
        if (inner.parentNode === el) el.removeChild(inner);
        resultFadeTimer = null;
        resultFadeFallback = null;
      };
      const onTransEnd = (e) => {
        if (e.propertyName === 'opacity') finish();
      };
      inner.addEventListener('transitionend', onTransEnd);
      resultFadeFallback = setTimeout(finish, fadeMs + 80);
    }, visibleMs);
  }

});
