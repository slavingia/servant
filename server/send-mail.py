#!/usr/bin/env python3
"""Servant mailer: reads {to, subject, text} JSON on stdin, sends through Gmail SMTP.
Credentials: server/data/mail.json (0600, gitignored data dir): {"user": "...@gmail.com", "appPassword": "xxxx xxxx xxxx xxxx"}"""
import json, os, smtplib, ssl, sys
from email.message import EmailMessage
here = os.path.dirname(os.path.abspath(__file__))
data = os.environ.get("SERVANT_DATA_DIR") or os.path.join(here, "data")
creds = json.load(open(os.path.join(data, "mail.json")))
m = json.load(sys.stdin)
msg = EmailMessage()
msg["From"] = f"Servant <{creds['user']}>"
msg["To"] = m["to"]
msg["Subject"] = m["subject"]
msg.set_content(m["text"])
# An explicit context: SMTP_SSL alone does not check the server certificate on older Pythons (3.9 here), so anyone
# on the path could pose as Gmail and read the app password and every sign-in code.
with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20, context=ssl.create_default_context()) as s:
    s.login(creds["user"], creds["appPassword"].replace(" ", ""))
    s.send_message(msg)
