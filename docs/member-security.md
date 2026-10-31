# Member agent security

> **Current setting (owner, October 31, 2026): full access for everyone.** By default the agent has the owner's full Hermes access in private chats, DMs and channels: files, terminal, web, memory, skills and connected services, with no approval prompts. Anyone who can message the agent, including anyone who joins with the team link, can make it read or change files and run commands on the server's Mac. Set `"agentAccess": "limited"` in `server/data/config.json` to go back to the restricted member bridge described below; the server re-reads the setting on every request, so no restart is needed.

Servant's member bridge uses an **empty tool allowlist**. Members can ask questions, work with text and inline images in their own conversation, and receive model answers. They cannot use the Mac's terminal, files, browser, connected services, other session history, generated local files, or agent delegation. The owner's bridge keeps its normal capabilities.

The policy is reviewable in [`server/member-policy.json`](../server/member-policy.json), and the reproducible Hermes configuration is [`config/profiles/member.json`](../config/profiles/member.json). The named denied tools document familiar examples; the empty allowlist also blocks future tools without needing to know their names. Adding a member capability requires a code and policy change with isolation tests. Tests cross-check the hub's self-contained deployment constants against the bridge policy.

## Memory and context isolation

Hermes' `X-Hermes-Session-Key` is a scope for external memory providers. It does **not** isolate the profile-wide `MEMORY.md` and `USER.md` stores. Servant disables both built-in stores and external memory for members:

```yaml
memory:
  memory_enabled: false
  user_profile_enabled: false
  provider: ""
```

The repository-owned bridge also constructs member agents with `enabled_toolsets=[]`, `skip_memory=True`, `skip_context_files=True`, and `load_soul_identity=False`. It disables background memory/skill review and checks the constructed agent's actual tools and memory stores before a model call. This second layer matters: Hermes configuration can automatically enable newly installed plugins or MCP tools. A YAML toolset list alone is not the enforcement boundary.

Members' session transcripts remain separate through Servant's authenticated conversation access checks. Context within the same conversation remains available. No member long-term memory is retained in a shared profile. These controls do not encrypt data at rest or stop the Mac owner or the configured model provider from reading messages.

The member bridge strips local `MEDIA:/path` directives before Hermes can resolve them. Otherwise even a tool-free model could echo a guessed filename and ask the transport to read it. User-attached inline images still work. Owner image output uses Hermes' existing validated, size-limited media resolver; no new arbitrary-file endpoint is introduced.

## Set up a separate member profile

Create a new directory; the command refuses to overwrite an existing profile and never copies owner credentials, memory, skills, or plugins:

```sh
node scripts/member-profile.mjs /absolute/path/to/servant-member 'your-model-id'
```

The generated `config.yaml` uses JSON syntax, which is valid YAML. Keep the directory private (0700) and its files private (0600). Configure only the model provider credentials and a **distinct** API key in that profile's private `.env`; do not copy the owner's `.env`. Use an `API_SERVER_KEY` with at least 32 random characters, and configure the matching `SERVANT_MEMBER_KEY` in the hub's private environment. Do not put credentials in this repository.

Run the bridge with the Python belonging to your Hermes installation:

```sh
/path/to/hermes/venv/bin/python scripts/run-hermes-servant.py \
  --hermes-root /path/to/hermes \
  --profile /absolute/path/to/servant-member --member --check

/path/to/hermes/venv/bin/python scripts/run-hermes-servant.py \
  --hermes-root /path/to/hermes \
  --profile /absolute/path/to/servant-member --member
```

It listens on authenticated `127.0.0.1:8643`. The owner's standalone bridge uses its existing owner profile, omits `--member`, and defaults to port 8642. Run each in its own process; do not attach this bridge to a shared multi-profile GatewayRunner or Desktop session authority. Your existing service supervisor can launch these commands. No Mac installer or menu bar application is required.

`--check` validates the source contract and profile without starting the API or using a model. The hub verifies the member bridge's policy capability over its authenticated loopback connection; ordinary Hermes does not satisfy this check. A missing bridge, policy drift, or unexpected tools fails closed instead of silently using an unrestricted owner agent. Installing code alone does not migrate a running deployment: launch the bridge and set the matching member upstream credentials before rollout.

## Evidence and limits

`node --test server/member-policy.test.mjs` verifies setup permissions, refusal to overwrite profiles, and rejection of missing or expanded policy attestations. `scripts/test-hermes-compat.py` constructs two real Hermes member agents against isolated test profiles containing sentinel `MEMORY.md`, `USER.md`, `SOUL.md`, and `AGENTS.md` files. It asserts that neither agent exposes tools or memory, neither prompt contains the other member's sentinel, and background review makes no changes. It also verifies that a member's local media directive cannot read a host image.

The bridge is an application-level control running on the owner's Mac, not an OS sandbox. The upstream API key, source checkout, host user, installed plugins, and model provider remain trusted. A compromised Mac or modified Hermes installation is outside this boundary. For stronger isolation, run the member bridge under a separate OS account or container with only its own profile and approved provider access.

Hermes source references: [agent initialization](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/agent/agent_init.py), [API adapter](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/gateway/platforms/api_server.py), and [toolset resolution](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/tools_config.py).
