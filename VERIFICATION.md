# Verification status

Updated 9 October 2026. This document distinguishes local mocked checks from live subscription verification.

## Release provenance

The historical live results below were recorded with the predecessor local prototype, version 0.1.0. This public version 0.2.0 changes the extension identity, app name, provider name and port, adds a first-use modal and request-based usage indication, and includes release documentation and licence notices. Those changes have automated coverage; no fresh live OAuth/browser or UI verification is claimed for version 0.2.0. Every installing user authorizes their own account. Private probe output and credentials were not copied into this repository.

## Automated checks

TypeScript checks and bundle build passed. All **30 tests** passed, covering request restrictions, explicit history, encrypted reasoning, unsupported tools, fragmented streamed function arguments, call IDs/results, loopback authorization/Origin/Host checks, cancellation, early EOF, usage limits, PKCE/callback validation, actual JWT signatures with generated RSA keys, identity mismatch, missing permission, refresh races, revocation and sign-out races. Additional checks cover authorization-code recovery with fresh state/nonce/PKCE and retained issued registration, cancelled browser listener cleanup, exact provider backups and preservation of unrelated/conflicting configuration. Release tests cover idle/consent/active/verification usage states, concurrent Assistant requests, first-use confirmation persistence and usage action, and the actual bridge activity hooks across admitted completion, rejection and cancellation. OpenAI network responses are mocked; JWT signatures and loopback HTTP are real local operations using synthetic tokens.

## Live checks

Target: Windows 11 x64, Positron 2026.09.0 / VS Code base 1.130.0, Posit Assistant **1.7.0**. The extension reports `win32`, `x64`, `remoteName: null`.

| Check | Observed result |
| --- | --- |
| Browser sign-in and consent | Passed; direct-plan scope granted using this extension's own OAuth registration |
| Account-specific model discovery | Passed; seven visible models returned by authenticated public `/v1/models` |
| Public subscription stream | Passed; GPT-6.1-Sol returned `Hello, world!` with HTTP 200, text deltas and `response.completed` |
| Built-in Assistant streaming | Passed; Assistant requests reached the loopback Responses bridge and completed with streamed text |
| Conversation history | Passed at protocol level; the second completed turn increased input history from 4 to 7 items, retaining prior conversation |
| Local file tool cycle | Passed; read, proposed edit, user approval, edit and reread; file changed to `state=verified` |
| Tool-result replay | Passed; subsequent Assistant streams included 1, then 2, then 3 function output items and completed |
| Assistant Stop control | Passed; live upstream request aborted, `cancelled: true`, `completed: false` |
| Real token renewal | Passed; documented refresh grant advanced expiry and retained direct-plan permission |
| Inference after renewal | Passed; another completed `Hello, world!` stream used the renewed session |
| Sign-out cleanup | Passed; remote revocation confirmed, both OAuth and bridge SecretStorage entries absent, bridge stopped and owned provider removed |
| Preserve unrelated providers | Passed; original OpenAI provider remained unchanged after cleanup |
| VSIX install/remove/reinstall | Passed through the installed Positron CLI; extension remains installed |
| Installed VSIX runtime | Passed; extension activated from the installed extensions directory, reused the saved registration after sign-out, discovered models, completed subscription inference and reconnected Assistant |

The live tool fixture is `test/fixtures/assistant-tool-probe.txt`, with marker `POSITRON-LOCAL-TOOLS-9142`. Only this dedicated file was requested for editing. The user approved its normal Assistant tool prompt. The bridge executes no tools itself.

The account catalog returned GPT-6.1-Sol, GPT-6-Astra, GPT-6-Sol, GPT-6-Luna, GPT-5.6-Sol, GPT-5.6-Terra and GPT-5.6-Luna. Only GPT-6.1-Sol inference was exercised; other model inference is not claimed.

The public endpoint omitted Content-Type while sending valid SSE. The bridge parses framing, preserves deltas and requires a completed terminal event; it does not infer success from HTTP status alone.

The predecessor's private evidence remains outside this copy. The public source and VSIX exclude probe output, user configuration and project approval settings. Manual probes run locally by a contributor can write diagnostics into ignored `.live/`; review and redact them before sharing.

## Manual acceptance sequence

1. Continue with ChatGPT and consent. Confirm the active account and direct-plan permission in connection status.
2. Discover Account Models. Verify Subscription Stream and require a completed response.
3. Connect Posit Assistant. Select a **ChatGPT OAuth (local)** model in Assistant.
4. Send a first turn with a unique marker; ask for it again in a follow-up. The bridge receipts should show increasing input history and completed streams.
5. Ask Assistant to read a dedicated test project file, propose a change, perform an approved edit, and report the result. The following bridge request should contain `function_call_output` items with matching call IDs.
6. Cancel a long Assistant response using its Stop control. Confirm the upstream stream aborts and the receipt records cancellation.
7. Sign Out. Confirm the provider is removed and SecretStorage no longer holds OAuth or bridge credentials. Confirm unrelated providers still match the backup.

Natural token expiry, a real usage-limit failure, other accounts, remote/WSL hosts and other Positron versions have not been exercised. Expiry and limit behavior are covered by mocked tests; no real token was corrupted and no usage limit was deliberately exhausted. The marker-recall reply was not independently inspected, so the history claim is limited to preserved inputs and completed follow-up inference.
