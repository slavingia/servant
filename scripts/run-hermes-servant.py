#!/usr/bin/env python3
"""Launch Servant's Hermes API bridge using the installed Hermes Python."""
import argparse
import asyncio
import os
from pathlib import Path
import signal
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--member", action="store_true")
    parser.add_argument("--port", type=int)
    parser.add_argument("--check", action="store_true", help="validate without starting the server")
    args = parser.parse_args()
    root, profile = args.hermes_root.resolve(), args.profile.resolve()
    if not (root / "gateway/platforms/api_server.py").is_file() or not (profile / "config.yaml").is_file():
        parser.error("Hermes source and an existing profile config.yaml are required")
    os.environ["HERMES_HOME"] = str(profile)
    # No tools from kanban work or inherited outer-agent contexts may sneak in.
    os.environ.pop("HERMES_KANBAN_TASK", None)
    sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "server"), str(root)]
    from hermes_bridge import ServantAPIServerAdapter, validate_member_profile, verify_contract
    from hermes_cli.config import load_config, load_env
    from gateway.config import PlatformConfig

    verify_contract()
    config = load_config()
    if args.member:
        validate_member_profile(config)
    if args.check:
        print("Servant Hermes contract and profile checks passed; no server started")
        return
    # Secrets stay in the selected profile or environment and are never printed.
    env = load_env()
    key = os.environ.get("API_SERVER_KEY") or env.get("API_SERVER_KEY")
    if not key or len(key) < 32:
        parser.error("Set a distinct API_SERVER_KEY of at least 32 characters for this bridge")
    for name, value in env.items():
        os.environ.setdefault(name, value)
    port = args.port or (8643 if args.member else 8642)
    adapter = ServantAPIServerAdapter(
        PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": port, "key": key}),
        restricted_member=args.member,
    )

    async def serve():
        if not await adapter.connect():
            raise RuntimeError("Hermes bridge could not start")
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, stop.set)
        try:
            await stop.wait()
        finally:
            await adapter.disconnect()

    asyncio.run(serve())


if __name__ == "__main__":
    main()
