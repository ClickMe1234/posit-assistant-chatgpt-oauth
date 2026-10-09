# Privacy and data handling

## Where requests go

Browser authentication goes directly to OpenAI. The extension uses documented OAuth endpoints under `https://auth.openai.com` and public model/inference endpoints under `https://api.openai.com/v1`. It does not use private ChatGPT backend endpoints, copy another application's credentials, or send data to the repository owner.

When you select **ChatGPT OAuth (local)**, Posit Assistant sends requests to a credential-protected bridge bound only to `127.0.0.1` on your PC. The bridge sends explicit conversation history, instructions, tool definitions and tool results to OpenAI. Project contents can therefore be included when you attach files or allow Assistant tools to read them. Assistant executes those tools locally under its own approval rules. `store: false` is sent on inference requests; it is not a promise that no provider-side processing or retention applies. OpenAI's current terms and your account/workspace settings apply.

The extension has no telemetry or analytics service. GitHub, Positron, Assistant and OpenAI have their own data practices outside this extension's control.

## Local storage

- OAuth access, refresh and ID tokens are stored together in VS Code/Positron SecretStorage.
- The random local bridge credential is kept in SecretStorage. Positron's authentication component securely stores its own copy so Assistant can authenticate to the bridge.
- The host UUID, account email, verified subject, issued client ID and selected registration are stored in extension global state. They are identifiers, not access credentials; the host/client mapping is retained after sign-out for reauthorization.
- Provider configuration remains in the user's `.posit/ai/providers.json`. Exact backups are written to this extension's local global-storage `provider-backups` directory. Backups may include unrelated provider settings and should be treated as private.
- Only the most recent 1000 request receipts are retained in memory. Receipts contain model IDs, counts, completion/cancellation flags, upstream status and optional request/error identifiers. They contain no prompt text, tool arguments, file contents or tokens. These receipts are also written to the local output channel, whose retention is controlled by the editor.
- Recent response output (assistant text, tool-call arguments and encrypted reasoning) is cached in memory to expand Assistant's stored-item references into explicit history. This cache is account-scoped, holds at most 1000 items / 16 MiB of serialized output, expires items after two hours, and clears on sign-out, account switching or bridge shutdown. It is never written to disk or diagnostics. Images in conversation messages and tool results are forwarded to OpenAI when the selected model supports them; receipts record only image counts.

The status command can print email, registration identifiers, local paths and receipts. Manual development probes may write similar diagnostics in `.live/`. These are not anonymous: redact them before posting an issue. Other installed extensions and editor logs are outside this extension's control.

## Sign-out and removal

Run **ChatGPT OAuth: Sign Out** before uninstalling. It aborts current bridge requests, attempts remote refresh-session revocation, deletes OAuth and bridge credentials, removes the owned provider and stops listening. If remote revocation fails, use ChatGPT settings to disconnect the app. Uninstalling alone does not execute cleanup: reinstall and sign out if necessary.

Non-secret host/account mappings, local configuration backups and editor-managed output can remain. After signing out and closing Positron, you can remove this extension's global-storage directory to erase those remaining local identifiers and backups. This does not erase conversations or logs managed by Assistant or other products.

The repository and VSIX contain no authenticated account, host ID, tokens or private provider configuration. Each installation starts its own authorization flow.
