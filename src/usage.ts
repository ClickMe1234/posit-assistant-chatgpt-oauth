import type { RequestReceipt } from './bridge';
import type { StateStore } from './oauth';
import { thinkingLabel } from './reasoning';

type ActiveRequest = Pick<RequestReceipt, 'sequence' | 'source'> & Partial<Pick<RequestReceipt, 'model' | 'reasoningEffort' | 'reasoningSource'>>;

export class UsageIndicator {
  private active = new Map<number, ActiveRequest>();
  private lastAssistant?: ActiveRequest;
  setActive(receipt: ActiveRequest, active: boolean) {
    if (active) {
      this.active.set(receipt.sequence, { ...receipt });
      if (receipt.source === 'assistant') this.lastAssistant = { ...receipt };
    }
    else this.active.delete(receipt.sequence);
  }
  presentation(signedIn: boolean, permitted: boolean) {
    if (!signedIn) this.lastAssistant = undefined;
    const requests = [...this.active.values()];
    const assistant = requests.filter(request => request.source === 'assistant');
    if (assistant.length) {
      const labels = [...new Set(assistant.map(request => thinkingLabel(request.reasoningEffort)))];
      return { text: `$(account) Using ChatGPT plan · Thinking: ${labels.join(', ')}`, command: 'chatgptOAuth.manageUsage', tooltip: assistant.map(request => `${request.model ?? 'Assistant'}: ${thinkingLabel(request.reasoningEffort)}${request.reasoningSource === 'model-default' ? ' (model default)' : ''}`).join('\n') + '\nThis Assistant request uses your ChatGPT plan. Click to manage usage.' };
    }
    const verification = requests.find(request => request.source === 'verification');
    if (verification) return { text: `$(sync~spin) Verifying ChatGPT plan · Thinking: ${thinkingLabel(verification.reasoningEffort)}`, command: 'chatgptOAuth.manageUsage', tooltip: 'A subscription verification request is active. Click to manage usage.' };
    const last = signedIn && permitted && this.lastAssistant;
    return { text: (signedIn ? permitted ? '$(account) ChatGPT OAuth: ready' : '$(account) ChatGPT OAuth: consent required' : '$(account) ChatGPT OAuth: sign in') + (last ? ` · Last thinking: ${thinkingLabel(last.reasoningEffort)}` : ''), command: 'chatgptOAuth.status', tooltip: 'ChatGPT OAuth connection status. Select ChatGPT OAuth (local) in Assistant to use your ChatGPT plan.' + (last ? `\nLast admitted Assistant request: ${last.model ?? 'Assistant'}, thinking: ${thinkingLabel(last.reasoningEffort)}. Choose the next level in Assistant’s model picker.` : '') };
  }
}

export async function showWelcomeOnce(state: StateStore, show: () => PromiseLike<'usage' | undefined>, openUsage: () => PromiseLike<unknown>) {
  if (state.get('welcomeShown', false)) return;
  const action = await show();
  await state.update('welcomeShown', true);
  if (action === 'usage') await openUsage();
}
