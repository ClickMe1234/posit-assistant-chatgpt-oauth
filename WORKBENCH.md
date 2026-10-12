# Positron Pro on Posit Workbench

Version 0.3.0 permits the server Node extension host used by browser-based Positron Pro. Desktop Positron still prefers its local UI host. This is an experimental integration: automated checks pass, but no live Workbench session has been exercised by the maintainer. A compatible Positron Pro 2026.09+ build must expose the custom-provider add/remove commands and allow custom providers. Administrator-enforced restrictions remain in effect.

## Why sign-in has an extra step

OpenAI's documented OAuth callback is `http://127.0.0.1:<port>/auth/callback`. In a browser-based Workbench session, that address reaches your PC, while the extension runs on the server. Changing it to a public Workbench HTTPS callback is not supported by the documented dynamic registration flow.

This extension follows the [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): authorize using the same tool on your PC, securely transfer a protected session to your server installation, preserve the server host ID and let the server manage refreshes. You do not need a separately billed API key or SSH port forwarding. You do need local Positron for the one-time authorization helper.

## Install and authorize

1. Install **the same 0.3.0 VSIX** in local Positron on your PC and Positron Pro in Workbench. Use **Extensions: Install from VSIX**, then **Developer: Reload Window** in both. On Workbench, install into the server session rather than a browser extension host. See [Posit's extension instructions](https://docs.posit.co/ide/server-pro/user/positron/guide/extensions.html).
2. **In Workbench**, run **ChatGPT OAuth: Prepare Workbench Sign-In** (also offered by Continue with ChatGPT). Save `chatgpt-oauth-workbench-request.json` somewhere you can download from Workbench. The request contains a public key and the server's persistent host ID. Its private key stays in this installation's SecretStorage. A new request replaces any earlier pending request; requests expire after one hour.
3. Download that request to your PC using Workbench's Files/Explorer download action. Only authorize a request you created in your own trusted Workbench account.
4. **In local Positron**, run **ChatGPT OAuth: Authorize Workbench on This PC**. Select the downloaded request and a destination for `chatgpt-oauth-workbench-session.json`. Complete ChatGPT browser login, workspace selection and plan consent. This uses fresh PKCE/state/nonce and validates the ID token. It creates a dedicated server-host authorization; it does not export or refresh your existing desktop session. The result is encrypted for the request's public key before writing to disk.
5. Upload the encrypted session JSON to the **same Workbench account and installation**. Run **ChatGPT OAuth: Import Workbench Sign-In** and select it. Workbench decrypts it, verifies the ID token and identity again, checks permission and expiry, and imports tokens into its SecretStorage. The one-time transfer private key is deleted after successful import. The server's host ID is preserved.
6. **In Workbench**, run **ChatGPT OAuth: Verify Subscription Stream**, then **ChatGPT OAuth: Connect Posit Assistant**. Select **GPT-6.1-Sol** (or another discovered model) under **ChatGPT OAuth (local)** in the built-in Assistant. The word “local” now means loopback inside your server session: the model is still hosted by OpenAI.
7. Delete the request and encrypted session files from your PC, Workbench and browser download locations after successful import. Do not commit transfer files, post them in issues or paste their contents into chat. The repository and VSIX exclude the default transfer filenames.

No further transfer is needed for normal access-token renewal. Workbench owns its rotating refresh token. If consent expires or is revoked, repeat these steps with a fresh request. Your separate desktop connection continues to use its own session.

## Requirements and troubleshooting

- Workbench needs outbound HTTPS access to `auth.openai.com` and `api.openai.com`, writable per-user extension storage, working SecretStorage and permission to configure a custom Assistant provider. If your administrator manages these settings, use their approved configuration.
- The bridge remains bound to `127.0.0.1`, with a random secure credential. Do not publish or forward its port. Assistant must run in the same server/network namespace; this package does not expose a public inference service.
- A “configured for desktop” error on an old VSIX is addressed by the new `extensionKind: ["ui", "workspace"]` declaration. Install 0.3.0 into the server and reload. This does not make a Node extension a pure browser extension.
- If custom-provider commands are unavailable, record **Help > About** version details and **View > Output > ChatGPT OAuth**. The extension reports the missing capability instead of claiming that all Workbench versions work. Do not share tokens, transfer JSON or unredacted account status.
- Expired, modified or wrong-installation files are rejected. Prepare a new request rather than editing the files. If the import reports an expired ID token, repeat authorization promptly.
- Use one active Workbench session with this provider per default port. A second bridge on the same server may need a different **ChatGPT OAuth: Port**, followed by reload and reconnect.
- Use **ChatGPT OAuth: Sign Out** inside Workbench before uninstalling. It removes imported tokens, pending transfer keys and the owned provider and attempts remote revocation. The desktop connection is separate. Workbench administrators control the server; SecretStorage does not protect credentials from a fully privileged server administrator.

## Verification limits

Tests exercise real RSA-3072/OAEP-SHA256 and AES-256-GCM encryption, tamper/expiry/wrong-host rejection, replay prevention, identity validation, preservation of the server host ID, subsequent mocked refresh/revocation, package host selection and all existing bridge regressions. OpenAI responses are mocked. Live browser authorization, Workbench SecretStorage, custom-provider registration, streaming and tool execution must still be checked on an actual Workbench deployment.
