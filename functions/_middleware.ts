import { maybeMarkdown } from '../lib/markdown-negotiation.ts';

export async function onRequest({ request, next }: { request: Request; next: () => Promise<Response> }): Promise<Response> {
  const response = await next();
  const path = new URL(request.url).pathname;
  if (/^\/api(?:\/|$)/i.test(path) || /\.(?:css|m?js|json|webmanifest|xml|txt|svg|png|jpe?g|gif|webp|ico|avif|woff2?|ttf|otf|map)$/i.test(path)) return response;
  return maybeMarkdown(request, response);
}
