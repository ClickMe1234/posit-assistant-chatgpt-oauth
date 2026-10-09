# Feasibility inspection — 9 October 2026

## Installed environment

- Windows 11 Pro, 64-bit, OS build 10.0.26200.
- Positron `2026.09.0`, VS Code base `1.130.0`, commit `58e9b87506d4132bf7f3340e883f16b4a982c266`.
- Initially installed user Assistant: `posit.assistant` `1.3.1`, bundled build marker `ca84ee9`. Launch selected the updated Assistant `1.7.0`; all live Assistant checks use that version. The bootstrap distribution contains Assistant 1.3.0.
- Node 24.18.0 and npm 11.16.0 are available for building.
- WSL Ubuntu and docker-desktop are installed. The live extension host reports `win32`, `x64`, and `remoteName: null`: authentication and the bridge run in Windows, not WSL.
- Existing providers.json has a configured OpenAI base URL. Its exact file is backed up before any provider mutation; unrelated entries are preserved.

## OpenAI's supported path

The current official [overview](https://developers.openai.com/siwc/token-sharing-open-source) describes ChatGPT plan use for locally hosted, open-source apps. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) specifies dynamic first-time registration, a persistent host ID, loopback callback, PKCE, state and nonce validation, the issued client ID, public-client code exchange and direct-plan permission. No partner API key or client secret is needed for this documented OSS flow.

The supplied `accounts-and-sessions` link returned an error. The overview's current navigation points to [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), which was read instead. It documents separate registrations, serialized refresh-token rotation, revocation, and keeping the host/client identity while deleting tokens at sign-out.

[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) specifies authenticated `GET https://api.openai.com/v1/models`, whose response uses `models`, `visibility`, `slug` and `display_name`, and streamed `POST https://api.openai.com/v1/responses`. OAuth tokens from this extension alone authorize the upstream calls. The bridge does not read credentials belonging to Codex or another app and does not use private ChatGPT backend endpoints.

[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) requires stateless streamed HTTP requests, developer messages instead of explicit system items, omitted unsupported fields, and namespaced function/custom tools. Assistant's local tool execution is compatible in principle; hosted tools and Responses tool_search are not. The namespace format is documented in the [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) is another documented transport but its catalog may be bundled and its tools/history are its own. A direct public Responses bridge is smaller and preserves Assistant's existing local tool execution.

**One account's access was established live with the predecessor prototype:** browser consent granted `chatgpt.tokens.use.direct`, the public catalog returned seven visible models, and GPT-6.1-Sol completed streamed responses, including built-in Assistant conversation and local tools. This does not establish other accounts' eligibility or constitute a fresh live run of the renamed release. Admission, workspace policy, region, app limits and eligibility can prevent inference. See [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). Detailed live results are in VERIFICATION.md.

## Positron and Assistant source evidence

Read the current [Positron provider documentation](https://positron.posit.co/assistant-providers.html), [Assistant provider configuration reference](https://assistant.posit.co/docs/reference/providers-config/), and [Positron source](https://github.com/posit-dev/positron).

The installed release is the authority for integration decisions. Relevant installed files:

- `resources/app/out/positron-dts/positron.d.ts`, around lines 3996–4364: `ai.registerProvider`/`updateProvider` configure provider UI metadata. Their callback is a configuration action, not an inference middleware callback.
- `resources/app/extensions/authentication/src/customProviderRegistry.ts`: `create(request)` validates, creates a dedicated custom entry, reconciles it, and calls `AuthProvider.storeKey`. Removal clears credentials before deleting only that entry.
- `resources/app/extensions/authentication/src/extension.ts`, around lines 312–335: callable `authentication.addCustomProvider` and `authentication.removeCustomProvider` command contracts accept structured arguments.
- `resources/app/extensions/authentication/src/validation/openai.ts`: OpenAI connection validation requests `/models`.
- `resources/app/extensions/authentication/src/validation/customProvider.ts`: default OpenAI-compatible validation probes `/chat/completions`.
- Installed Assistant `dist/extension.js`: its `openai` client factory sets `apiMode: "responses"`; OpenAI-compatible uses Chat Completions by default. Both can be routed by protocol settings. Assistant contains its own provider catalog/registry and AI SDK request implementation; no public request-middleware registration hook was found in its exports.
- Assistant's existing `posit-assistant.newChat` command accepts prompt, target, behavior, persona, attachments and conversation/session identifiers. It does not accept a model-selection argument; the model must be selected in Assistant's UI.

The public [ai-lib OpenAIClient implementation](https://github.com/posit-dev/ai-lib/blob/main/packages/ai-provider-bridge/src/model-clients/OpenAIClient.ts) corroborates Responses versus Chat Completions routing and shows why raw forwarding is insufficient: maxOutputTokens is forwarded and tool definitions are flat. Public main-source snapshots were stored in ignored `.research/`; they are corroboration, not a claim that upstream main exactly matches the installed release.

## Smallest viable integration

A local TypeScript UI extension owns OAuth and a credential-protected `127.0.0.1` Responses bridge. Assistant's existing custom OpenAI provider calls this endpoint. Its configuration is automated through inspected installed commands, with feature detection and a backup. The bridge transforms the requests and SSE events, while Assistant maintains history and executes tools.

No Positron source change is required for this path on the inspected release. The add/remove command contracts are installed capabilities, not a promised stable API across releases; incompatible releases fail explicitly. A future public Assistant middleware/provider extension API could remove the loopback bridge. A separate chat panel is not part of this implementation.
