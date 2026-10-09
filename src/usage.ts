import type { RequestReceipt } from './bridge';
import type { StateStore } from './oauth';

export class UsageIndicator {
  private active = new Map<number, RequestReceipt['source']>();
  setActive(receipt: Pick<RequestReceipt, 'sequence' | 'source'>, active: boolean) {
    if (active) this.active.set(receipt.sequence, receipt.source);
    else this.active.delete(receipt.sequence);
  }
  presentation(signedIn: boolean, permitted: boolean) {
    const sources = [...this.active.values()];
    if (sources.includes('assistant')) return { text: '$(account) Using ChatGPT plan', command: 'chatgptOAuth.manageUsage', tooltip: 'This Assistant request uses your ChatGPT plan. Click to manage usage.' };
    if (sources.includes('verification')) return { text: '$(sync~spin) Verifying ChatGPT plan', command: 'chatgptOAuth.manageUsage', tooltip: 'A subscription verification request is active. Click to manage usage.' };
    return { text: signedIn ? permitted ? '$(account) ChatGPT OAuth: ready' : '$(account) ChatGPT OAuth: consent required' : '$(account) ChatGPT OAuth: sign in', command: 'chatgptOAuth.status', tooltip: 'ChatGPT OAuth connection status. Select ChatGPT OAuth (local) in Assistant to use your ChatGPT plan.' };
  }
}

export async function showWelcomeOnce(state: StateStore, show: () => PromiseLike<'usage' | undefined>, openUsage: () => PromiseLike<unknown>) {
  if (state.get('welcomeShown', false)) return;
  const action = await show();
  await state.update('welcomeShown', true);
  if (action === 'usage') await openUsage();
}
