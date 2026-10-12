# Changelog

## 0.3.0

- Permit the Node workspace extension host for Positron Pro on Workbench while preserving the desktop UI-host preference.
- Add Prepare Workbench Sign-In, Authorize Workbench on This PC, and Import Workbench Sign-In commands. A dedicated local OAuth authorization is encrypted to a one-time server public key using RSA-3072/OAEP-SHA256 and AES-256-GCM.
- Validate imported identity, permission and expiry, preserve the server host ID, and let the server own later refreshes. Existing desktop sessions are not exported or shared.
- Delete the one-time transfer key after import or sign-out and reject replay, wrong-installation, expired and modified files.
- Feature-detect custom-provider commands without requiring the desktop authentication-extension ID. Add Workbench instructions and explicit verification limits.
- Workbench integration has mocked-network and local cryptographic coverage; live Positron Pro server verification remains outstanding.

## 0.2.1

- Enable image attachments and plot/tool-result images for discovered GPT-6 and GPT-5.6 model families. Preserve inline image content in Responses requests.
- Expand Assistant SDK stored-item references from bounded, account-scoped in-memory output history. This fixes a reproduced storage mismatch that can cause upstream 404 errors with `store: false`; the precise cause of the reported laptop 404 remains unverified.
- Automatically back up and migrate the owned 0.2.0 provider's image flags on activation; preserve unrelated providers and disabled state. Saved sign-in is reused.
- Report image/reference counts without logging contents. Provide recovery instructions when history has expired or was lost on reload.
- Add mocked plot-tool streaming/multi-turn replay, cache isolation/expiry/bounds, image adaptation and provider migration regression tests. Start a new Assistant chat after upgrading. No fresh live image inference is claimed.

## 0.2.0

- First public release as **Posit Assistant ChatGPT OAuth**, publisher `clickme1234`.
- Independent extension identity, OAuth app name, provider `ChatGPT OAuth (local)` and loopback port 17864.
- First-use plan confirmation is modal and appears once.
- Plan-use status follows actual admitted Assistant streams; idle and verification states are distinct.
- Usage-limit UI offers Manage usage directly.
- Added privacy/security documents, independent-project and trademark notices, runtime dependency licence and reproducible CI build.
- Preserved the predecessor's OAuth, public Responses bridge, history/tool adaptation, cancellation and cleanup implementation.

Historical integration evidence comes from the predecessor 0.1.0 prototype. See VERIFICATION.md for the distinction from this release's mocked tests.
