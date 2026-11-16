# The agent's network gate

Off by default. When it is on, the agent runs in a sandbox whose only way out to the network is a small proxy inside the Servant server, and that proxy refuses everything it has not been told to allow. A person's agent reaches a host only when that person holds an [entitlement](entitlements.md) that covers it.

## What happens to a connection

1. A host on the server's `always` list goes through for anyone. This is for what the agent itself needs to run, such as the model provider.
2. Otherwise the connection is judged for a person:
   - if it carries a person's token, for that person;
   - if it carries none, for everyone whose agent is working at that moment, and it goes through only when every one of them may reach the host. With nobody working, it is refused.
3. A person may reach a host when they hold an entitlement that covers it.
4. A refused connection gets `403` with a line the agent can read ("it needs the entitlement "Tax data API", which the person you are working for does not hold"), is written down, and the person (or the owners, when no entitlement covers the host) is told once.
5. The proxy never connects to this machine, the local network or other private address ranges, whatever an entitlement says, so a public name cannot be pointed inward.

HTTPS stays encrypted from the agent to the site: the proxy sees the host name and port and nothing inside. It stores no request or reply text.

## Turn it on

1. In the server's `config.json`:

   ```json
   "agentEgress": { "mode": "ask", "port": 8790, "always": ["models.example.gov"], "holdSeconds": 0 }
   ```

   - `mode`: `"ask"` turns the gate on. Anything else is off.
   - `port`: where the proxy listens on localhost (default 8790).
   - `always`: hosts every agent may reach without an entitlement. Put the model provider here, and as little else as you can.
   - `holdSeconds`: how long a refused connection waits for the person's manager before it fails (0 to 120). 0 fails at once and the agent tries again later.

2. Restart the server. It logs `agent network gate on 127.0.0.1:8790`. `always` and `holdSeconds` are read again for every connection; turning the gate on or off, or changing the port, needs a restart.

3. Start the agent through the sandbox wrapper instead of directly:

   ```sh
   scripts/run-agent-sandboxed.sh /path/to/hermes/venv/bin/python scripts/run-hermes-servant.py --hermes-root /path/to/hermes
   ```

   On a Mac the wrapper uses `sandbox-exec`: the command and everything it starts can open outbound connections only to the gate's port (and local sockets between its own processes). It can still listen, read and write files and run commands. `SERVANT_SANDBOX_LOCAL_PORTS="9222 5432"` opens other localhost ports it needs. On Linux the wrapper uses `systemd-run` with `IPAddressDeny=any` and `IPAddressAllow=localhost`; for a unit, put those two lines and the proxy variables in its `[Service]` section. If no sandbox is available the wrapper refuses to start the agent rather than start it open.

4. Make entitlements for the systems the team's agents should reach ([entitlements.md](entitlements.md)).

The gate without the sandbox does nothing: a command can ignore the proxy variables. The sandbox without the gate leaves the agent with no network at all, which is the safe way for it to fail.

## Limits

Say these out loud before relying on it.

- **Hosts, not content.** Allowing a host allows everything on it that the agent's credentials can do, including sending data to it.
- **Web and browser tools that go through a gateway** are seen as the gateway's host. If the gateway is on the `always` list, the agent can read any public page through it and the gate does not see which. Leave it off the list unless that is acceptable.
- **Per-person tokens are not passed to the agent yet.** Until the bridge gives each person's commands their own token, traffic is judged for everyone whose agent is working at that moment. Two people working at once can only reach what both may reach; that is strict, never loose.
- **Only agent chats count as "working".** A reply to `@agent` in a channel or direct message does not, so it reaches only the `always` list.
- **Tools that don't use a proxy** (some websocket and browser paths) have no network inside the sandbox.
- **The Linux wrapper has not been run on a server yet**; the Mac one has.
- The sandbox limits the network only. Files and commands on the server's computer are as open as they were; see [member-security.md](member-security.md).
