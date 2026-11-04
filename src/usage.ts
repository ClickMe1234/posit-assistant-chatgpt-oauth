import type { RequestReceipt } from './bridge';
import type { StateStore } from './oauth';
import { thinkingLabel } from './reasoning';
import { PLAN_WINDOWS, type PlanUsage } from './plan-usage';

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
  presentation(signedIn: boolean, permitted: boolean, plan?: PlanUsage) {
    const display = this.connectionPresentation(signedIn, permitted);
    if (!signedIn || !permitted) return display;

    const balances: string[] = [];
    const details = PLAN_WINDOWS.map(window => {
      const reading = plan?.windows[window];
      if (!reading) return `${window} balance unavailable`;
      const remaining = `${window} ${formatNumber(reading.remainingPercent)}% left`;
      balances.push(remaining);
      const reset = reading.resetsAt ? ` · reset ${new Date(reading.resetsAt * 1000).toLocaleString()}` : '';
      const change = reading.sharedChangePoints === undefined ? '' :
        ` · shared usage change ${reading.sharedChangePoints > 0 ? '+' : ''}${formatNumber(reading.sharedChangePoints)} percentage points`;
      return `${remaining} · reported ${new Date(reading.observedAt).toLocaleString()}${reset}${change}`;
    });
    const tokens = plan?.lastAssistantResponse?.tokenUsage;
    if (tokens) {
      details.push(`Last completed Assistant request used ${tokens.totalTokens.toLocaleString()} tokens (${tokens.inputTokens.toLocaleString()} input, ${tokens.outputTokens.toLocaleString()} output).`);
    }
    details.push('Plan windows are shared. An individual request’s percentage of the plan allowance is unavailable.');
    return {
      ...display,
      text: balances.length ? `${display.text} · Last reported ${balances.join(' · ')}` : display.text,
      tooltip: `${display.tooltip}\n\n${details.join('\n')}`,
    };
  }
  private connectionPresentation(signedIn: boolean, permitted: boolean) {
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

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export async function showWelcomeOnce(state: StateStore, show: () => PromiseLike<'usage' | undefined>, openUsage: () => PromiseLike<unknown>) {
  if (state.get('welcomeShown', false)) return;
  const action = await show();
  await state.update('welcomeShown', true);
  if (action === 'usage') await openUsage();
}
