# Security

Servant carries private conversations, so we want to hear about vulnerabilities before anyone else does.

## Reporting

Please do not open a public issue for a security problem. Use GitHub's private reporting:
**Security > Report a vulnerability** on this repository. Include what you found, the steps to reproduce it, and which build or release it affects.

You will get a reply within three working days. We will say whether we can reproduce it, and keep you posted until it is fixed. We will credit you in the release notes if you want.

## What is in scope

- The server (`server/`): pairing, device tokens, roles, the encrypted transport
- The relay (`relay/`)
- The phone app (`app/`) and the Mac app (`desktop/`)
- The MCP server (`mcp/`)

How the encryption works is in [docs/encryption.md](docs/encryption.md) and [docs/member-security.md](docs/member-security.md).

## What is not

- Attacks that need your computer or phone to be unlocked and in the attacker's hands
- Problems in your own agent, model provider or tunnel
- Reports without a way to reproduce them

## Use with sensitive information

Servant is not approved for customer, personnel or other sensitive data. Do not put it through Servant until your own organization has approved it.
