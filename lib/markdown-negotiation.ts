/**
 * Markdown for Agents content negotiation for Cloudflare Workers / Pages Functions.
 * Copy this file into the target repo and hook it after the existing HTML response
 * is produced. Do not convert non-HTML responses, redirects, or API payloads.
 */

export function prefersMarkdown(request: Request): boolean {
  const accept = request.headers.get('Accept') || request.headers.get('accept') || '';
  if (!accept) return false;
  let markdownQ = -1;
  let htmlQ = -1;
  for (const part of accept.split(',')) {
    const [rawType, ...params] = part.trim().split(';');
    const type = rawType.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q') {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (type === 'text/markdown' || type === 'text/x-markdown') markdownQ = Math.max(markdownQ, q);
    if (type === 'text/html') htmlQ = Math.max(htmlQ, q);
  }
  return markdownQ > 0 && markdownQ >= htmlQ;
}

export function isHtmlResponse(response: Response): boolean {
  if (!(response.status >= 200 && response.status < 300)) return false;
  const contentType = response.headers.get('Content-Type') || '';
  return /text\/html/i.test(contentType);
}

function withVaryAccept(headers: Headers): Headers {
  const next = new Headers(headers);
  const vary = next.get('Vary');
  if (!vary) next.set('Vary', 'Accept');
  else if (!/\bAccept\b/i.test(vary)) next.set('Vary', `${vary}, Accept`);
  return next;
}

export function addVaryAccept(response: Response): Response {
  if (response.headers.get('Vary') && /\bAccept\b/i.test(response.headers.get('Vary') || '')) return response;
  const headers = withVaryAccept(response.headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function strip(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities((match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim());
}

function titleFrom(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) return decodeEntities(title.replace(/<[^>]+>/g, '')).trim();
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i)?.[0];
  if (og) return attr(og, 'content');
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return h1 ? decodeEntities(h1.replace(/<[^>]+>/g, '')).trim() : '';
}

function convertFragment(html: string, baseUrl: string): string {
  let input = html;
  input = input.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe']) input = strip(input, tag);
  let remaining = input.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || input.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || input.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    || input;
  remaining = remaining.replace(/<br\s*\/?>/gi, '\n');
  remaining = remaining.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
  remaining = remaining.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = attr(tag, 'alt') || 'image';
    const src = attr(tag, 'src');
    if (!src) return alt;
    try { return `![${alt}](${new URL(src, baseUrl).href})`; } catch { return `![${alt}](${src})`; }
  });
  remaining = remaining.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, body) => {
    const href = attr(`<a ${attrs}>`, 'href');
    const text = decodeEntities(body.replace(/<[^>]+>/g, '')).trim() || href;
    if (!href) return text;
    try { return `[${text}](${new URL(href, baseUrl).href})`; } catch { return `[${text}](${href})`; }
  });
  remaining = remaining.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const text = decodeEntities(body.replace(/<[^>]+>/g, '')).trim();
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '';
  });
  remaining = remaining.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, body) => `\n\n\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, '')).trimEnd()}\n\`\`\`\n\n`);
  remaining = remaining.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => `\n\n\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, '')).trimEnd()}\n\`\`\`\n\n`);
  remaining = remaining.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => `\`${decodeEntities(body.replace(/<[^>]+>/g, '')).trim()}\``);
  remaining = remaining.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, body) => `**${decodeEntities(body.replace(/<[^>]+>/g, '')).trim()}**`);
  remaining = remaining.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, body) => `*${decodeEntities(body.replace(/<[^>]+>/g, '')).trim()}*`);
  remaining = remaining.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => `\n- ${decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}`);
  remaining = remaining.replace(/<\/(p|div|section|header|footer|tr|table|ul|ol|blockquote)>/gi, '\n\n');
  remaining = remaining.replace(/<[^>]+>/g, ' ');
  remaining = decodeEntities(remaining);
  remaining = remaining.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return remaining;
}

export function htmlToMarkdown(html: string, pageUrl: string): string {
  const title = titleFrom(html);
  const body = convertFragment(html, pageUrl);
  const parts = ['---'];
  if (title) parts.push(`title: ${title}`);
  parts.push(`url: ${pageUrl}`, '---', '');
  if (body) parts.push(body, '');
  return parts.join('\n');
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function maybeMarkdown(request: Request, response: Response): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return response;
  if (!prefersMarkdown(request)) {
    return isHtmlResponse(response) ? addVaryAccept(response) : response;
  }
  if (!isHtmlResponse(response)) return response;
  if (method === 'HEAD') {
    const headers = withVaryAccept(response.headers);
    headers.set('Content-Type', 'text/markdown; charset=utf-8');
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  const html = await response.text();
  const markdown = htmlToMarkdown(html, request.url);
  const headers = withVaryAccept(response.headers);
  headers.set('Content-Type', 'text/markdown; charset=utf-8');
  headers.set('x-markdown-tokens', String(estimateTokens(markdown)));
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  return new Response(response.status === 204 || response.status === 205 ? null : markdown, { status: response.status, statusText: response.statusText, headers });
}
