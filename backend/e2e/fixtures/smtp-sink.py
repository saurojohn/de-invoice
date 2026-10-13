#!/usr/bin/env python3
"""A mailbox for the specs: an SMTP server that accepts every message and
writes it to DIR/NNN.eml, so a spec can look at what the customer would have
received — the attachment itself, not only its file name.

Usage: smtp-sink.py DIR   → prints the port it listens on (127.0.0.1), then
serves until it is killed. Used by 407-tier683-….sh."""
import os, socketserver, sys, threading

DIR = sys.argv[1]
os.makedirs(DIR, exist_ok=True)
lock, count = threading.Lock(), [0]

class Handler(socketserver.StreamRequestHandler):
    def say(self, line):
        self.wfile.write(line.encode() + b"\r\n"); self.wfile.flush()
    def handle(self):
        self.say("220 sink ESMTP")
        while True:
            raw = self.rfile.readline()
            if not raw: return
            cmd = raw.decode("latin-1").strip(); up = cmd.upper()
            if up.startswith("EHLO"):
                self.say("250-sink"); self.say("250-AUTH PLAIN LOGIN"); self.say("250 SIZE 52428800")
            elif up.startswith("HELO"): self.say("250 sink")
            elif up.startswith("AUTH PLAIN"):
                if up == "AUTH PLAIN": self.say("334 "); self.rfile.readline()
                self.say("235 ok")
            elif up.startswith("AUTH LOGIN"):
                self.say("334 VXNlcm5hbWU6"); self.rfile.readline()
                self.say("334 UGFzc3dvcmQ6"); self.rfile.readline(); self.say("235 ok")
            elif up.startswith("DATA"):
                self.say("354 go"); body = []
                while True:
                    line = self.rfile.readline()
                    if not line or line in (b".\r\n", b".\n"): break
                    body.append(line[1:] if line.startswith(b"..") else line)
                with lock:
                    count[0] += 1; n = count[0]
                with open(os.path.join(DIR, "%03d.eml" % n), "wb") as f: f.write(b"".join(body))
                self.say("250 queued")
            elif up.startswith("QUIT"): self.say("221 bye"); return
            else: self.say("250 ok")

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True; daemon_threads = True

with Server(("127.0.0.1", 0), Handler) as srv:
    print(srv.server_address[1], flush=True); srv.serve_forever()
