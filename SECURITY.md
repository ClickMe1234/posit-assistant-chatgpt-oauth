# Security

This project is an independent prototype. Current release 0.3.x is the maintained line; fixes are provided as new source and VSIX releases. Workbench support is experimental. No company endorsement or security certification is claimed.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/ClickMe1234/posit-assistant-chatgpt-oauth/security/advisories/new) for vulnerabilities. Do not put credentials, callback URLs, private project contents, configuration backups or unredacted status output in public issues. For ordinary non-sensitive bugs, include editor/Assistant versions and a minimal reproduction with synthetic data.

## Boundaries

- Loopback only; random local bearer credential, exact Host check, browser Origin rejection.
- PKCE, state, nonce, ID-token signature/issuer/audience/expiry and account-identity validation.
- Serialized rotating token refresh and SecretStorage credential persistence.
- No automatic API billing fallback and no tool execution in the bridge.
- Provider changes preserve unrelated entries and create local backups.
- Workbench handoff files use RSA-OAEP-SHA256 and AES-256-GCM, are bound to an expiring installation-specific request, and can be imported only once. Imported ID tokens are verified before persistence. Fully privileged server administrators remain inside the trust boundary.

Any extension installed in your editor can have substantial local privileges. Install releases only from a source you trust, review the code if needed, and keep editor and dependencies current. See PRIVACY.md for storage and cleanup.
