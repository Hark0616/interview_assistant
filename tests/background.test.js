import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('background.js - OpenRouter', () => {
  let helpers;

  beforeEach(() => {
    global.importScripts = vi.fn();
    global.chrome = {
      commands: { onCommand: { addListener: vi.fn() } },
      tabs: { query: vi.fn() },
      runtime: {
        onMessage: { addListener: vi.fn() },
        onConnect: { addListener: vi.fn() }
      }
    };

    const source = fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8');
    eval(`${source}\n;globalThis.__backgroundTest = {\n` +
      `normalizeUsage, getRetryDelayMs, validateApproximateContext, ` +
      `handleAISuggestionStream, cancelMemoryRequest, activeMemoryRequests, PROVIDERS\n` +
      `};`);
    helpers = global.__backgroundTest;
  });

  it('normaliza la telemetría del último evento SSE', () => {
    expect(helpers.normalizeUsage({
      prompt_tokens: 120,
      completion_tokens: 30,
      cost: 0.004,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
      completion_tokens_details: { reasoning_tokens: 7 }
    })).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      reasoningTokens: 7,
      cachedTokens: 80,
      cacheWriteTokens: 15,
      cost: 0.004
    });
  });

  it('construye una solicitud OpenRouter con sesión, routing y caché Claude', () => {
    const body = helpers.PROVIDERS.openrouter.buildBody(
      'prompt estable',
      [{ role: 'user', content: 'pregunta' }],
      'anthropic/claude-sonnet-5',
      {
        sessionId: 'meeting-123',
        routing: 'latency',
        reasoningEffort: 'low',
        maxCompletionTokens: 384,
        temperature: 0.3
      }
    );

    expect(body.max_completion_tokens).toBe(384);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.session_id).toBe('meeting-123');
    expect(body.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('construye el payload de Gemini con system instruction y roles compatibles', () => {
    const body = helpers.PROVIDERS.gemini.buildBody(
      'responde en español',
      [{ role: 'user', content: 'pregunta' }, { role: 'assistant', content: 'respuesta previa' }],
      'gemini-flash-latest',
      { maxCompletionTokens: 256, temperature: 0.2 }
    );

    expect(body.systemInstruction.parts[0].text).toBe('responde en español');
    expect(body.contents.map((item) => item.role)).toEqual(['user', 'model']);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 256, temperature: 0.2 });
  });

  it('construye el payload de Groq con autenticación y límite de salida', () => {
    const headers = helpers.PROVIDERS.groq.buildHeaders('groq-key');
    const body = helpers.PROVIDERS.groq.buildBody(
      'system', [{ role: 'user', content: 'question' }], 'llama-3.3-70b-versatile',
      { maxCompletionTokens: 128, temperature: 0.1 }
    );

    expect(headers.Authorization).toBe('Bearer groq-key');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system' });
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.1);
  });

  it('respeta Retry-After expresado en segundos', () => {
    const response = { headers: { get: vi.fn(() => '12') } };
    expect(helpers.getRetryDelayMs(response, 500)).toBe(12000);
  });

  it('cancela por sesión una actualización de memoria de baja prioridad', () => {
    const controller = new AbortController();
    helpers.activeMemoryRequests.set('meeting-123', { controller, requestId: 'memory-1' });

    expect(helpers.cancelMemoryRequest('meeting-123', 'Petición principal')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.message).toBe('Petición principal');
    expect(helpers.activeMemoryRequests.has('meeting-123')).toBe(false);
  });

  it('rechaza contextos estimados que no caben en el modelo', () => {
    expect(() => helpers.validateApproximateContext(
      'x'.repeat(4000),
      [{ content: 'y'.repeat(4000) }],
      { contextLength: 1500 },
      512
    )).toThrow(/no cabe/);
  });

  it('propaga errores que llegan dentro de un SSE con HTTP 200', async () => {
    global.fetch = vi.fn(async () => new Response(
      'data: {"error":{"message":"Proveedor saturado","metadata":{"error_type":"provider_error"}}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    ));
    const port = { postMessage: vi.fn() };
    const requestRef = {
      controller: new AbortController(),
      markActivity: vi.fn()
    };

    await helpers.handleAISuggestionStream({
      provider: 'openrouter',
      apiKey: 'key',
      model: 'anthropic/claude-sonnet-5',
      systemPrompt: 'sistema',
      messages: [{ role: 'user', content: 'pregunta' }]
    }, port, requestRef);

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'error',
      error: 'Proveedor saturado (provider_error)',
      partial: false
    });
  });

  it('entrega usage normalizado en el mensaje done del stream', async () => {
    global.fetch = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"Respuesta"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":' +
      '{"prompt_tokens":50,"completion_tokens":10,"cost":0.002}}\n\n' +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    ));
    const port = { postMessage: vi.fn() };
    const requestRef = {
      controller: new AbortController(),
      markActivity: vi.fn()
    };

    await helpers.handleAISuggestionStream({
      provider: 'openrouter',
      apiKey: 'key',
      model: 'anthropic/claude-sonnet-5',
      systemPrompt: 'sistema',
      messages: [{ role: 'user', content: 'pregunta' }]
    }, port, requestRef);

    const done = port.postMessage.mock.calls.map(([message]) => message)
      .find((message) => message.type === 'done');
    expect(done.usage).toMatchObject({ promptTokens: 50, completionTokens: 10, cost: 0.002 });
    expect(requestRef.markActivity).toHaveBeenCalledWith(true);
  });
});
