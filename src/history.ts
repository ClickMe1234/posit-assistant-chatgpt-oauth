import { BridgeError } from './errors';

// Assistant's SDK can send item_reference when its store option defaults to true.
// The subscription route never stores responses. Expand references locally instead
// of asking OpenAI to retrieve an item that does not exist on that route.
export class ResponseHistory {
  private items = new Map<string, { item: any; bytes: number; at: number }>();
  private bytes = 0;
  private account?: string;
  constructor(private maxBytes = 16 * 1024 * 1024, private maxItems = 1000,
    private ttl = 2 * 60 * 60 * 1000, private now = Date.now) {}

  selectAccount(account: string) {
    if (this.account !== account) { this.clear(); this.account = account; }
  }
  clear() { this.items.clear(); this.bytes = 0; this.account = undefined; }
  private prune() {
    for (const [id, entry] of this.items) {
      if (this.now() - entry.at < this.ttl && this.bytes <= this.maxBytes && this.items.size <= this.maxItems) break;
      this.items.delete(id); this.bytes -= entry.bytes;
    }
  }
  remember(event: any, account: string) {
    // A stream cancelled during account switching must not repopulate the cache.
    if (this.account !== account) return;
    const output = event.type === 'response.output_item.done' ? [event.item]
      : event.type === 'response.completed' ? event.response?.output ?? [] : [];
    for (const item of output) {
      if (!item || typeof item.id !== 'string' || !['message', 'reasoning', 'function_call', 'custom_tool_call', 'web_search_call'].includes(item.type)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(item));
      const previous = this.items.get(item.id);
      if (previous) { this.items.delete(item.id); this.bytes -= previous.bytes; }
      if (bytes > this.maxBytes) continue;
      this.items.set(item.id, { item: structuredClone(item), bytes, at: this.now() }); this.bytes += bytes;
    }
    this.prune();
  }
  resolve = (id: string): any => {
    this.prune();
    const entry = this.items.get(id);
    if (!entry) throw new BridgeError(409, 'history_item_unavailable', 'Assistant referenced history that is no longer available locally. Start a new Assistant chat after updating or reloading Positron.');
    // Return a clone: request adaptation must never mutate cached output.
    return structuredClone(entry.item);
  };
}
