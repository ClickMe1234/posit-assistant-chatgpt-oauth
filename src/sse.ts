import { BridgeError } from './errors';

export async function* events(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (frame: string) => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return undefined;
    try { return JSON.parse(data); } catch { throw new BridgeError(502, 'invalid_stream', 'OpenAI returned a malformed stream event.'); }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Normalize CRLF only when complete; a CR may straddle network chunks.
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 16 * 1024 * 1024) throw new BridgeError(502, 'stream_too_large', 'An upstream stream event exceeded the safety limit.');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event !== undefined) yield event;
      }
      if (done) break;
    }
    if (buffer.trim()) { const event = parse(buffer); if (event !== undefined) yield event; }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function encodeEvent(event: any): string {
  return `event: ${event.type ?? 'error'}\ndata: ${JSON.stringify(event)}\n\n`;
}
