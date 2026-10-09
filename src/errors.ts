export class BridgeError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public param?: string, public retryAfter?: string, public bodyShape?: string) { super(message); }
}

export async function upstreamError(response: Response): Promise<BridgeError> {
  let body: any;
  try { body = await response.json(); } catch { body = {}; }
  const code = typeof body?.error?.code === 'string' ? body.error.code : typeof body?.error === 'string' ? body.error : `upstream_http_${response.status}`;
  // Do not expose raw server text: auth failures can reflect credential-bearing input.
  const messages: Record<string, string> = {
    subscription_sharing_user_not_eligible: 'ChatGPT plan usage is unavailable for this account, workspace or policy.',
    subscription_sharing_usage_limit_exceeded: 'ChatGPT plan or app usage limit reached. Manage usage at https://chatgpt.com/#settings/Usage. No billing fallback was used.',
    subscription_sharing_usage_unavailable: 'ChatGPT usage availability could not be checked. Try again later.',
    subscription_sharing_unsupported_capability: 'This model or request capability is unsupported by ChatGPT plan usage.',
    subscription_sharing_route_not_supported: 'The subscription route rejected this endpoint or method.',
    invalid_grant: 'The renewable session has expired or was revoked. Continue with ChatGPT again.',
    invalid_token: 'The access token was rejected. Continue with ChatGPT again.'
  };
  const fallback = response.status === 401 ? 'OpenAI rejected the selected account credentials or direct-plan permission.'
    : response.status === 403 ? 'OpenAI denied this request due to account, workspace, region or policy restrictions.'
    : response.status === 429 ? 'OpenAI usage limit reached. Manage usage at https://chatgpt.com/#settings/Usage.'
    : response.status === 503 ? 'The public subscription route is unavailable or not enabled. Try again later.'
    : `OpenAI request failed (HTTP ${response.status}).`;
  return new BridgeError(response.status, code, messages[code] ?? fallback,
    response.headers.get('x-request-id') ?? response.headers.get('openai-request-id') ?? undefined,
    typeof body?.error?.param === 'string' ? body.error.param : undefined,
    response.headers.get('retry-after') ?? undefined,
    typeof body?.error === 'string' ? 'oauth-error-string' : body?.error && typeof body.error === 'object' ? 'error-object' : typeof body?.detail === 'string' ? 'detail-string' : 'other');
}

export function safeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new BridgeError(499, 'cancelled', 'Request cancelled.');
  return new BridgeError(502, 'bridge_failure', 'The bridge could not complete the request. Check connectivity and connection status.');
}
