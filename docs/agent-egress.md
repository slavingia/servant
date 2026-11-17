# The agent's network gate

Off by default. When it is on, the agent runs in a sandbox whose only way out to the network is a small proxy inside the Servant server, and that proxy refuses everything it has not been told to allow. A person's agent reaches a host only when that person holds an [entitlement](entitlements.md) that covers it.

## What happens to a connection

1. A host on the server's `always` list goes through for anyone. This is for what the agent itself needs to run, such as the model provider.
2. Otherwise the connection is judged for a person:
   - if it carries a person's token (terminal commands do, once the bridge is started through the wrapper below), for that person;
   - if it carries none, for everyone whose agent is working at that moment, and it goes through only when every one of them may reach the host. With nobody working, it is refused.
3. A person may reach a host when they hold an entitlement that covers it.
4. A refused connection gets `403` with a line the agent can read ("it needs the entitlement "Tax data API", which the person you are working for does not hold"), is written down, and the person (or the owners, when no entitlement covers the host) is told once.
5. The proxy never connects to this machine, the local network or other private address ranges, whatever an entitlement says, so a public name cannot be pointed inward.

6. A connection that is let through is written down first: who it was for (or the agent itself, for an `always` host with nobody working), the host, the day, and how many that day. If it can't be written down it isn't made. Owners see the latest under **Recently reached** in Entitlements (`egress.reached` in `GET /v1/entitlements`).

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

   The bridge needs `server/hermes_egress.py` beside `server/hermes_bridge.py`. If you run the bridge from a copy of those files rather than from this repository, copy it too; without it the bridge still starts, and commands are judged for everyone working instead of for one person.

   On a Mac the wrapper uses `sandbox-exec`: the command and everything it starts can open outbound connections only to the gate's port (and local sockets between its own processes). It can still listen, read and write files and run commands. `SERVANT_SANDBOX_LOCAL_PORTS="9222 5432"` opens other localhost ports it needs. On Linux the wrapper uses `systemd-run` with `IPAddressDeny=any` and `IPAddressAllow=localhost`; for a unit, put those two lines and the proxy variables in its `[Service]` section. If no sandbox is available the wrapper refuses to start the agent rather than start it open.

4. Close the server's own files to the agent (Mac). The agent runs as the same user as the server, so without this it can read the server's keys and databases whenever it may read files at all, including the secret that signs the tokens saying whose traffic is whose. Close the data folder and open only the folders the agent is handed files in:

   ```sh
   export SERVANT_SANDBOX_DENY_PATHS="/Users/you/servant/server/data:/Users/you/.config/servant"
   export SERVANT_SANDBOX_ALLOW_PATHS="/Users/you/servant/server/data/chat-files:/Users/you/servant/server/data/project-files:/Users/you/servant/server/data/prototypes:/Users/you/servant/server/data/long-messages"
   ```

   A closed path can't be read, written, listed, moved, copied or linked to by the agent or anything it starts, and a file that doesn't exist yet is closed for when it does. Paths must be absolute; the wrapper refuses to start if one can't be resolved. On Linux use `InaccessiblePaths=` and `BindPaths=` in the agent's unit; the wrapper refuses these two settings there rather than ignore them.

5. Make entitlements for the systems the team's agents should reach ([entitlements.md](entitlements.md)).

The gate without the sandbox does nothing: a command can ignore the proxy variables. The sandbox without the gate leaves the agent with no network at all, which is the safe way for it to fail.

## Limits

Say these out loud before relying on it.

- **Hosts, not content.** Allowing a host allows everything on it that the agent's credentials can do, including sending data to it.
- **Web and browser tools that go through a gateway** are seen as the gateway's host. If the gateway is on the `always` list, the agent can read any public page through it and the gate does not see which. Leave it off the list unless that is acceptable.
- **Whose traffic it is.** Each turn tells the bridge whose it is, and that chat's terminal commands present a token to the gate, so they are judged for that person alone. Each chat with a token gets its own shell; in a thread several people share, the shell starts fresh when a different person asks. Traffic that carries no token (the agent's own process, tools that don't run in the terminal, and everything on a Hermes too old to support this) is judged for everyone whose agent is working at that moment: agent chats, replies to `@agent`, and wiki pages the agent is writing. Two people working at once can then only reach what both may reach; that is strict, never loose.
- **The token is not a wall between people.** It keeps a command honest about whose it is. Commands still run as one user on one computer, and one that goes looking can read another's environment. For a real wall, run each person's agent under its own account or container.
- **Tools that don't use a proxy** (some websocket and browser paths) have no network inside the sandbox.
- **The Linux wrapper has not been run on a server yet**; the Mac one has.
- Apart from the network and the paths you close (step 4), files and commands on the server's computer are as open to the agent as they were; see [member-security.md](member-security.md). The agent's own profile (its model credentials, memory and skills) has to stay readable to it.
