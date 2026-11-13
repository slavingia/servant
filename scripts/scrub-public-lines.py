#!/usr/bin/env python3
"""Filter only explicitly reviewed public identity lines from scrub hits.

The owner authorized publishing this personal deployment's public identity on
2026-11-11: name, domain, support address, independence disclaimer and identifying
public deployment labels. The owner also explicitly requested a personal-project
credit linking their name to their public website. Its two JSON fields are allowed
only in app/project-credit.json, with the reviewed four-line layout; extra fields
or nesting invalidate those exceptions. The exact paths below are the only
eligible files.
Each digest pins the COMPLETE UTF-8 source line, including its context and spacing.
Any addition, replacement or move loses the exception. No filename is exempt.

These immutable fingerprints keep the policy itself free of the names/addresses
that the general denylist correctly rejects elsewhere. To update one, review the
entire proposed source line first; never regenerate this list from failing hits.
This policy does not authorize credentials, private data or server configuration.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import sys

# The public credit is exactly one name field and one website field, in this order.
PROJECT_CREDIT_LINES = (
    "3109b5d5955041243fcbf194437c633edd64cf8a84e3a95e41fd74f7d43ea523",  # Published credit name
    "2ceb32fc7b622e5c18057c51d20e8f6a1d8285dd94e9c3c89c3a465a7454756a",  # Published credit website
)

# Each set pins only the reviewed public identity fields in the named file.
APPROVED_LINES: dict[str, frozenset[str]] = {
    "app/project-credit.json": frozenset(PROJECT_CREDIT_LINES),
    "deploy/personal/README.md": frozenset({
        "138389fac2c7ae2d4750bf591e8fa6915a90fd61e40347a1450722d6c07c3aec",  # Reviewed personal deployment identity
        "a546fb1f44d370b17c939f99eade925f54bdb5e28d04784a027bf09848e8ca73",  # Reviewed personal deployment identity
        "cc73438d1f325d340a1efd0a390d6a5de5e40252fcc8332977e7492217df6bdc",  # Reviewed personal deployment identity
        "cb1069e7c957fa6b376ecfa420146bc33b8a06c2ef2bbb0d58e1cd2af35b35ab",  # Published application identity
        "b9ba9542886548f065ea0a16476ba26d5eb4612efc71b55aa7d027e4876ef099",  # Reviewed personal deployment identity
        "0335275f7aeaf8f5ca4b436c5e6c3e7a3efdb0220c85e1a67ccd3c73254ce501",  # Reviewed personal deployment identity
        "52d6445ce7686b43b823664bfddb5ece9b24fb233f0565af0821fe839888d048",  # Published application identity
        "56a64a80067ff2e1508dd244fdcd9c25311c44de9b4adfbb38ce3a4029da1740",  # Published application identity
        "381c6427595e97c1701ddcd53bdb1bf60e57d35de3b833d438d6ac34f15664f6",  # Reviewed personal deployment identity
        "a41899f317c66012e52926c957c46e520d1eaf1c50f7bbc99b18703606a7d6de",  # Personal deployment project scope
    }),
    "deploy/personal/public/index.html": frozenset({
        "96a60e2f6c4d5e221cc514556209217d39f3a193510af296ffa3f1de425e5281",  # Public owner description
        "7e04a59785b17a5c1fd8465016658bccb293720abe6314a1a97ef366158457b6",  # Canonical public domain
        "90f047233322b05d2d826b3a847261db446d33592977b940b9694ec8d58eda4c",  # Public owner title
        "2d44d379396e933fff67149fed6f2d28d3a096feb69d4651087ae17558cc232c",  # Public owner credit
        "aa40240a364832e7158921e08fadc424b778d0b3355518af136c34a414e5d530",  # Public owner and independence statement
        "c14fccc6ba85a2a25566c7d9c64c3a4534295d26147556de44b70367fcc1684f",  # Published support contact
    }),
    "deploy/personal/public/support.html": frozenset({
        "bec073f448402647708758f234c1053580ee7ec4cd3da2a6f71a640d4ca3c47c",  # Public owner description
        "5f379793523cc62e40db971c6c680c50d872f461701f8a85bfd544acff51cebb",  # Canonical public domain
        "92499ed1027aff26ef571694f5f696e9b5fdf4bf8b09b912ea20fcaf0311b247",  # Published support contact
        "497e87100e86f0ef96624f5878102a367a58fb92bcfae3a8fd2496fcd65ec770",  # Public owner and independence statement
    }),
    "deploy/personal/public/privacy.html": frozenset({
        "5a2ec13cbb4aaed8c4f135be753f79d6a551795e545ae27e788ba6e0a9056f46",  # Canonical public domain
        "2f2aa32d7dbc7bb44a820ea681875545500278fbaf1f092c1d2b24efd8e0b4c1",  # Published support contact
        "d1b79ea4f6e75e08358ec624decd7c268d6894ed57ceacc1151d7219adaacf64",  # Published support contact
        "ab2993c2d8c7b0d74096084052bb50e016d012674db841a883bc35e5e68e3dac",  # Public owner and independence statement
        "c14fccc6ba85a2a25566c7d9c64c3a4534295d26147556de44b70367fcc1684f",  # Published support contact
    }),
    "deploy/personal/public/terms.html": frozenset({
        "b2af2622ae8af45f9267aecf5b35658c248d2cebaca3d53d70d25fa8cbf89c7b",  # Canonical public domain
        "6110b3ed81f570262ba7fdb3c35cdeb204bb768e9923c9a65b7db72fe99027da",  # Published support contact
        "03f5bd1fc5d0ad81c2359d41eab2f6b469a5242ecb00ed85bd3f77be0531acf5",  # Published support contact
        "f2516b96a3f6292feb77f3ecf8fb34e475eb8b186fb1ea81b6a4c823628f651b",  # Public owner and independence statement
        "c14fccc6ba85a2a25566c7d9c64c3a4534295d26147556de44b70367fcc1684f",  # Published support contact
    }),
}


def filter_hits(records: str, root: Path = Path(".")) -> str:
    cache: dict[str, list[bytes]] = {}
    remaining = []
    for record in records.splitlines(keepends=True):
        parts = record.split(":", 2)
        if len(parts) != 3 or parts[0] not in APPROVED_LINES or not parts[1].isdigit() or int(parts[1]) < 1:
            remaining.append(record)
            continue
        name, number, _ = parts
        try:
            if name not in cache:
                cache[name] = (root / name).read_bytes().splitlines()
            lines = cache[name]
            if name == "app/project-credit.json" and not (
                len(lines) == 4 and lines[0] == b"{" and lines[3] == b"}"
                and tuple(hashlib.sha256(line).hexdigest() for line in lines[1:3]) == PROJECT_CREDIT_LINES
            ):
                remaining.append(record)
                continue
            line = lines[int(number) - 1]
            approved = hashlib.sha256(line).hexdigest() in APPROVED_LINES[name]
        except (OSError, IndexError):
            approved = False
        if not approved:
            remaining.append(record)
    return "".join(remaining)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: scrub-public-lines.py <grep-hits-file>")
    sys.stdout.write(filter_hits(Path(sys.argv[1]).read_text()))
