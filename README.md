# Posit Assistant ChatGPT OAuth

**Independent community project. Not affiliated with or endorsed by OpenAI or Posit.**

Free, MIT-licensed source and a manually installable VSIX. This project does not redistribute Positron or Posit Assistant. Download those applications from their official distributors.

An MIT-licensed local prototype that connects **Posit Assistant** to the documented ChatGPT subscription Responses route. It uses browser consent and OAuth, without an OpenAI API key. Account eligibility must be established by live consent and a successfully completed response; documentation alone does not establish your account's access.

## Install and use

1. Download `posit-assistant-chatgpt-oauth-0.2.1.vsix` from this repository's [GitHub Releases](https://github.com/ClickMe1234/posit-assistant-chatgpt-oauth/releases). In Positron, run **Extensions: Install from VSIX** and choose it. Reload if requested. The predecessor integration was verified on Windows, Positron 2026.09.0 and Assistant 1.7.0; see the verification notes for the distinction between that live run and this release's automated tests.
2. Run **ChatGPT OAuth: Continue with ChatGPT**. Complete login, select your workspace and consent in the system browser. Returning accounts reuse their issued registration.
3. Run **ChatGPT OAuth: Discover Account Models**, then **ChatGPT OAuth: Verify Subscription Stream**. A stream must reach `response.completed` to count as success.
4. Run **ChatGPT OAuth: Connect Posit Assistant**. It backs up `~/.posit/ai/providers.json`, creates the dedicated **ChatGPT OAuth (local)** custom OpenAI provider, securely stores its random local credential through Positron's authentication command, and declares models from the authenticated account. Other providers remain in the file.
5. Open **Posit Assistant** and select a model belonging to **ChatGPT OAuth (local)**. Use the built-in Assistant conversation and tools.

After first sign-in, a one-time modal explains plan usage and links to usage settings. The status bar says **Using ChatGPT plan** only while an admitted Assistant stream is active through this bridge; clicking it opens usage settings. A signed-in idle connection says **ChatGPT OAuth: ready**. Standalone stream checks say **Verifying ChatGPT plan**. This extension cannot read Assistant's selected model, so it does not claim that an idle Assistant is using this provider. Select **ChatGPT OAuth (local)** in the model picker to route requests here.

**ChatGPT OAuth: Show Connection Status** opens diagnostics without tokens, but they can include your email, registration identifier and local paths. Review/redact them before sharing. **Manage Usage** opens ChatGPT's usage settings. Plan/app limits apply; there is no automatic fallback to separately billed API usage. A usage-limit failure offers **Manage usage** as its primary action.

The extension runs in the local UI extension host (`extensionKind: ui`). The inspected machine is Windows 11; WSL is installed, but this integration is intended to run in Windows Positron. A remote Assistant host that cannot reach this PC's loopback bridge is outside the verified target.

For normal use after the development probes, close the verification/development windows and reopen Positron normally. The installed extension starts its bridge using the saved session. Use one window with this provider at a time, and select **ChatGPT OAuth (local)** in Assistant's model picker.

This release has its own extension ID, OAuth app name, provider name and port. It does not import sessions from the earlier local prototype or from another application. Existing prototype users must sign in afresh. To retire the old prototype, use its own **Sign Out** command before uninstalling it.

## Remove and sign out

Run **ChatGPT OAuth: Sign Out** before uninstalling. It aborts in-flight requests, attempts remote renewable-session revocation, deletes all OAuth tokens and the local bridge credential from SecretStorage, removes its Assistant provider and Positron's copy of the local credential, and stops listening. The opaque host ID and non-secret account/client mapping remain for reauthorization, as OpenAI documents. If revocation cannot be confirmed, disconnect the app in ChatGPT Settings.

**Remove Assistant Provider** removes only this integration's provider, preserving sign-in. Then uninstall the extension through Positron's Extensions view. VS Code extensions cannot run an uninstall hook: if you uninstall without cleanup, reinstall to sign out and remove the provider, or remove **ChatGPT OAuth (local)** through Positron's provider dialog and disconnect the app in ChatGPT Settings.

Configuration backups are in this extension's global storage `provider-backups` directory; **Show Connection Status** identifies the last backup. Prefer removing the dedicated entry over restoring an entire backup if you have edited other providers since connection.

## Build and tests

```powershell
npm ci
npm run check
npm test
npm run package
```

The VSIX bundles its runtime OAuth library; installation does not require npm, Python, WSL or an API key. The local endpoint binds to `127.0.0.1` only, rejects browser origins and unexpected Host headers, requires a random 256-bit bearer credential, and never exposes the OAuth tokens. The default port is 17864. Only one bridge instance may bind that port; change **ChatGPT OAuth: Port** and reload if another window owns it.

**Unit/integration tests mock OpenAI network responses.** JWT signature tests use actual generated RSA keys. These tests do not demonstrate subscription eligibility. `test/live-host.cjs` is a separate manual probe for the installed Positron extension host; it opens browser sign-in, discovers account models, runs live inference, connects Assistant and records only token-free results in ignored `.live/` files.

## Protocol and scope

This bridge accepts **Responses** requests at `/v1/responses`; it intentionally does not implement `/chat/completions`. In the inspected Assistant, `openai` defaults to Responses and `openai-compatible` defaults to Chat Completions, with explicit protocol overrides available. This integration uses a custom `openai` entry and explicitly selects `openai-responses`.

The adapter always sends `store: false`, `stream: true` and explicit input history, converts system messages to developer messages, removes unsupported sampling/state parameters, wraps Assistant function tools in a namespace, and flattens returned calls for Assistant's existing SDK. Function calls, IDs, argument deltas, function results and encrypted reasoning are preserved. **Assistant executes tools on your PC**, subject to its own permissions; the bridge does not run tools. Hosted MCP, Responses tool search, Code Interpreter, image generation and other unsupported tools fail explicitly.

The discovered GPT-6 and GPT-5.6 model families advertise image attachments and images returned by local tools such as `getPlot`, matching Assistant 1.7.0's capabilities. PNG, JPEG, GIF and WebP input is declared; unknown model families remain text-only. Image input is supported by the [documented subscription route](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) when the selected model accepts it. Image generation remains unsupported. Context limits use the account catalog's context window where supplied, with conservative defaults otherwise. Reconnect Assistant after switching accounts to refresh its model list. It does not claim all catalog metadata is an entitlement guarantee.

Assistant's Responses SDK can send stored-item references when reasoning is off. Because subscription responses use `store: false`, the bridge expands these references from recent output held only in memory, including encrypted reasoning. The cache is account-scoped, bounded to 1000 items / 16 MiB of serialized output, expires items after two hours, and is cleared on sign-out, account switching or bridge shutdown. Missing references produce a local recovery error; the bridge never retrieves private backend history. Only the last 1000 token-free request receipts are retained in memory.

## Updating from 0.2.0 and plot troubleshooting

Install the new VSIX over 0.2.0 and run **Developer: Reload Window**. Your saved sign-in remains in SecretStorage. The extension backs up and updates its existing provider's image flags once, preserving unrelated providers and a disabled provider's state. Start a **new Assistant chat**, select GPT-6.1-Sol under **ChatGPT OAuth (local)**, and ask it to inspect the current plot again. Existing chats may retain the old model capabilities or reference outputs from before the reload.

If the image warning remains, run **ChatGPT OAuth: Connect Posit Assistant**, then start another new chat. If a request fails, open **View > Output**, choose **ChatGPT OAuth**, and copy only the relevant `Request:` receipt. New receipts show `inputImages` and `resolvedReferences` counts without image contents, prompt text or credentials. Do not post the full connection-status output without redacting account details and local paths. A remaining HTTP 404 needs that new receipt for diagnosis; the original report did not include enough detail to establish its precise cause.

Read [FEASIBILITY.md](FEASIBILITY.md) and [VERIFICATION.md](VERIFICATION.md) for evidence and remaining limitations, [PRIVACY.md](PRIVACY.md) for data handling, [SECURITY.md](SECURITY.md) for reporting issues, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled library licence.

## Project scope and trademarks

This is a free local extension; account/workspace eligibility and plan or app limits still apply. There is no promise of unlimited usage, availability for every account, or approval by either company. Paid or remotely hosted versions require a separate review of OpenAI's current requirements.

Names of compatible products are used descriptively. OpenAI and ChatGPT are trademarks of their respective owner. Posit, RStudio, and Shiny are trademarks of Posit Software, PBC, all rights reserved, and may be registered in the United States Patent and Trademark Office and in other countries. Positron and Posit Assistant names identify the applications this extension works with. This project uses no company logos.

Official references: [OpenAI plan usage](https://developers.openai.com/siwc/token-sharing-open-source), [OpenAI UI guidance](https://developers.openai.com/siwc/ui-ux-guidelines), [Positron extensions](https://positron.posit.co/extensions.html), and [Posit trademark guidance](https://posit.co/about/trademark-guidelines). This repository does not represent a legal approval or trademark clearance.
