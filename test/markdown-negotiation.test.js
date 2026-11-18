import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.ts';

async function request(accept, response, { method = 'GET', path = '/' } = {}) {
  const headers = accept ? { Accept: accept } : {};
  return onRequest({ request: new Request(`https://example.com${path}`, { method, headers }), next: async () => response });
}

const html = () => new Response('<html><title>Archery</title><main><h1>Open Float</h1><p>Hello</p></main></html>', {
  headers: { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Origin', 'Content-Length': '80' },
});

test('negotiates markdown and preserves existing Vary', async () => {
  const response = await request('text/markdown', html());
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('vary'), 'Origin, Accept');
  assert.equal(response.headers.get('content-length'), null);
  assert.match(await response.text(), /# Open Float/);
});

test('defaults to HTML and respects preference and q=0', async () => {
  for (const accept of [null, 'text/html, text/markdown;q=0.5', 'text/markdown;q=0']) {
    const response = await request(accept, html());
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('vary'), 'Origin, Accept');
  }
});

test('supports x-markdown and HEAD without a body', async () => {
  const response = await request('text/x-markdown', html(), { method: 'HEAD' });
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await response.text(), '');
});

test('leaves non-HTML, errors, redirects, API routes and other methods alone', async () => {
  for (const [response, options] of [
    [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), {}],
    [new Response('missing', { status: 404, headers: { 'Content-Type': 'text/html' } }), {}],
    [Response.redirect('https://example.com/elsewhere'), {}],
    [html(), { path: '/api/example' }],
    [html(), { path: '/missing.css' }],
    [html(), { path: '/service-worker.js' }],
    [html(), { method: 'POST' }],
  ]) {
    assert.equal(await request('text/markdown', response, options), response);
  }
});
