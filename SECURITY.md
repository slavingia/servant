# Security

Servant carries private conversations, so we want to hear about vulnerabilities before anyone else does.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a security problem. Report it privately through GitHub's security advisories: on this repository, go to **Security > Advisories > Report a vulnerability**. Include:

- what you found and why it matters
- the steps to reproduce it
- which commit, build or release it affects

Do not include real secrets, tokens, invite codes, messages or anyone's personal data in a report. Use a throwaway server and made-up people to reproduce it; if you must show sensitive output, describe it instead.

## What to expect

- A first reply within three working days.
- We will say whether we can reproduce it, agree on a fix and a disclosure date with you, and keep you posted until it ships.
- We will credit you in the release notes if you want.

Please give us a reasonable chance to fix a problem before you disclose it publicly.

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

Servant is early software and its encryption protocol has not had an independent audit. Do not put personal, regulated or otherwise sensitive information through it until your own organization has reviewed and approved it for that use.

## If you committed a secret

If you find a credential, key or personal data in this repository or its history, report it privately as above rather than in an issue, so it can be rotated before it is pointed out publicly.
