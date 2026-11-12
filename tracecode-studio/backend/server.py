#!/usr/bin/env python3
"""TraceCode Studio - local web interface.

Standard library only. Endpoints:
  POST /api/analyze  runs every compiler phase on the source and returns all results
  POST /api/run      builds the program with NASM and ld, then runs the native executable
  GET  /api/examples, GET /api/health

Running a program executes a native Linux binary on THIS machine, with a 5 second limit.
Use it only on your own computer, never on a public server.

Usage:  make serve        (or:  python3 backend/server.py [port])
Open:   http://127.0.0.1:8000
"""
import base64
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
COMPILER = os.path.join(ROOT, "build", "tracec")
FRONTEND = os.path.join(ROOT, "frontend")
EXAMPLES = os.path.join(ROOT, "examples")
MAX_SOURCE = 64 * 1024
MAX_INPUT = 4 * 1024
TIMEOUT_TOOL = 10
TIMEOUT_RUN = 5

ERROR_RE = re.compile(r"\[(\w+) error\] line (\d+), col (\d+): (.*)")
FIX_SPLIT = " | Fix: "
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}

PIPELINE = [
    ("lexer", "Lexer"),
    ("parser", "Parser / AST"),
    ("semantic", "Semantic"),
    ("symbols", "Symbol table"),
    ("tac", "TAC"),
    ("optimizer", "Optimizer"),
    ("codegen", "NASM codegen"),
    ("run", "Link & run"),
]


def run_tool(args, stdin=None, timeout=TIMEOUT_TOOL, cwd=None):
    try:
        p = subprocess.run(args, input=stdin, capture_output=True, text=True,
                           timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "[Internal error] line 0, col 0: timed out"
    except FileNotFoundError as e:
        return 127, "", "[Internal error] line 0, col 0: missing tool: %s" % e.filename


def parse_errors(stderr, path_label):
    errors = []
    for line in stderr.splitlines():
        m = ERROR_RE.match(line)
        if m:
            message, fix = m.group(4), ""
            if FIX_SPLIT in message:
                message, fix = message.split(FIX_SPLIT, 1)
            errors.append({"category": m.group(1), "line": int(m.group(2)),
                           "col": int(m.group(3)), "message": message, "fix": fix})
        elif line.strip():
            errors.append({"category": "Internal", "line": 0, "col": 0,
                           "message": line.replace(path_label, "program.tl"), "fix": ""})
    return errors


def write_temp(source):
    fd, path = tempfile.mkstemp(suffix=".tl", prefix="tracelang_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(source)
    return path


def analyze(source):
    if not os.path.isfile(COMPILER):
        return {"ok": False, "fatal": "Compiler not built. Run `make` in the project folder."}
    path = write_temp(source)
    try:
        label = os.path.basename(path)
        _, tokens, tok_err = run_tool([COMPILER, "--tokens", path])
        rc_ast, ast, ast_err = run_tool([COMPILER, "--ast", path])
        errors = parse_errors(ast_err, label)
        parsed = bool(ast.strip())
        sem_errors = [e for e in errors if e["category"] in ("Semantic", "Type")]
        lex_errors = [e for e in errors if e["category"] == "Lexical"]
        syn_errors = [e for e in errors if e["category"] == "Syntax"]

        symbols = dot = svg = ""
        svg_note = ""
        if parsed:
            _, symbols, _ = run_tool([COMPILER, "--symbols-tsv", path])
            _, dot, _ = run_tool([COMPILER, "--dot", path])
            if shutil.which("dot"):
                _, svg, svg_err = run_tool(["dot", "-Tsvg"], stdin=dot)
                if not svg.strip():
                    svg, svg_note = None, svg_err.strip() or "Graphviz produced no output"
            else:
                svg, svg_note = None, "Graphviz 'dot' is not installed, so the graph image is unavailable."

        tac = tac_opt = asm = asm_opt = ""
        report = None
        asm_instr = {"plain": 0, "opt": 0}
        if parsed and not sem_errors:
            rc, out, _ = run_tool([COMPILER, "--phases", path])
            if rc == 0 and out.strip():
                bundle = json.loads(out)
                tac, tac_opt = bundle["tac"], bundle["tac_opt"]
                asm, asm_opt = bundle["asm"], bundle["asm_opt"]
                report = bundle["report"]
                asm_instr = bundle["asm_instr"]

        if not parsed:
            status = {"lexer": "error" if lex_errors else "done",
                      "parser": "error" if (syn_errors or lex_errors) else "done",
                      "semantic": "skipped", "symbols": "skipped", "tac": "skipped",
                      "optimizer": "skipped", "codegen": "skipped", "run": "skipped"}
        elif sem_errors:
            status = {"lexer": "done", "parser": "done", "semantic": "error",
                      "symbols": "partial", "tac": "skipped", "optimizer": "skipped",
                      "codegen": "skipped", "run": "skipped"}
        else:
            status = {"lexer": "done", "parser": "done", "semantic": "done",
                      "symbols": "done", "tac": "done", "optimizer": "done",
                      "codegen": "done", "run": "ready"}

        return {
            "ok": parsed and not errors,
            "tokens": tokens or "",
            "ast": ast if parsed else "",
            "symbols": symbols,
            "dot": dot,
            "svg": svg,
            "svg_note": svg_note,
            "errors": errors,
            "tac": tac,
            "tac_opt": tac_opt,
            "report": report,
            "asm": asm,
            "asm_opt": asm_opt,
            "asm_instr": asm_instr,
            "phases": status,
            "pipeline": [{"id": pid, "label": lbl, "status": status[pid]} for pid, lbl in PIPELINE],
        }
    finally:
        os.unlink(path)


def run_program(source, stdin_text, optimized):
    """Compile to NASM, assemble and link with the system tools, then execute."""
    needed = {"nasm": shutil.which("nasm"), "ld": shutil.which("ld")}
    missing = [name for name, p in needed.items() if not p]
    if missing:
        return {"ok": False, "stage": "tools",
                "message": "Missing tool(s): %s. Install with: sudo apt install -y nasm binutils"
                           % ", ".join(missing)}
    if not os.path.isfile(COMPILER):
        return {"ok": False, "stage": "tools", "message": "Compiler not built. Run `make`."}

    src = write_temp(source)
    work = tempfile.mkdtemp(prefix="tracerun_")
    try:
        label = os.path.basename(src)
        mode = "--asm-opt" if optimized else "--asm"
        rc, asm, cerr = run_tool([COMPILER, mode, src])
        if rc != 0:
            return {"ok": False, "stage": "compile", "errors": parse_errors(cerr, label)}

        asm_path = os.path.join(work, "program.asm")
        obj_path = os.path.join(work, "program.o")
        exe_path = os.path.join(work, "program")
        with open(asm_path, "w", encoding="utf-8") as f:
            f.write(asm)

        rc, _, nerr = run_tool(["nasm", "-f", "elf64", asm_path, "-o", obj_path])
        if rc != 0:
            return {"ok": False, "stage": "assemble", "message": nerr.strip()}
        rc, _, lerr = run_tool(["ld", obj_path, "-o", exe_path])
        if rc != 0:
            return {"ok": False, "stage": "link", "message": lerr.strip()}

        try:
            p = subprocess.run([exe_path], input=stdin_text, capture_output=True,
                               text=True, timeout=TIMEOUT_RUN)
            return {"ok": p.returncode == 0, "stage": "run", "stdout": p.stdout,
                    "stderr": p.stderr, "exit_code": p.returncode, "asm": asm}
        except subprocess.TimeoutExpired:
            return {"ok": False, "stage": "run", "stdout": "",
                    "stderr": "program stopped after %d seconds (possible infinite loop)" % TIMEOUT_RUN,
                    "exit_code": 124, "asm": asm}
    finally:
        try:
            os.unlink(src)
        except OSError:
            pass
        shutil.rmtree(work, ignore_errors=True)


def list_examples():
    names = sorted(n for n in os.listdir(EXAMPLES) if n.endswith(".tl"))
    out = []
    for n in names:
        with open(os.path.join(EXAMPLES, n), encoding="utf-8") as f:
            out.append({"name": n, "source": f.read()})
    return out


PASSWORD = os.environ.get("TRACECODE_PASSWORD", "")


def password_ok(header):
    """True when no password is set, or the Basic auth password matches (any user name)."""
    if not PASSWORD:
        return True
    if not header or not header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    given = decoded.split(":", 1)[1] if ":" in decoded else ""
    return hmac.compare_digest(given.encode("utf-8"), PASSWORD.encode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    server_version = "TraceCodeStudio/0.2"

    def require_password(self):
        """Sends 401 with a login prompt and returns False when the password is missing or wrong."""
        if password_ok(self.headers.get("Authorization")):
            return True
        body = b'{"error": "password required"}'
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="TraceCode Studio"')
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send_bytes(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        self.send_bytes(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def read_json(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > limit:
            raise ValueError("request body must be between 1 byte and %d bytes" % limit)
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(body, dict):
            raise ValueError("request body must be a JSON object")
        return body

    def do_GET(self):
        path = urlparse(self.path).path
        if not self.require_password():
            return
        if path in STATIC:
            name, ctype = STATIC[path]
            with open(os.path.join(FRONTEND, name), "rb") as f:
                return self.send_bytes(200, f.read(), ctype)
        if path == "/api/examples":
            return self.send_json(200, {"examples": list_examples()})
        if path == "/api/health":
            return self.send_json(200, {
                "compiler_built": os.path.isfile(COMPILER),
                "graphviz": shutil.which("dot") is not None,
                "nasm": shutil.which("nasm") is not None,
                "ld": shutil.which("ld") is not None,
            })
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if not self.require_password():
            return
        try:
            if path == "/api/analyze":
                body = self.read_json(MAX_SOURCE)
                source = body.get("source")
                if not isinstance(source, str):
                    raise ValueError("source must be a string")
                return self.send_json(200, analyze(source))
            if path == "/api/run":
                body = self.read_json(MAX_SOURCE + MAX_INPUT)
                source = body.get("source")
                stdin_text = body.get("input", "")
                if not isinstance(source, str) or not isinstance(stdin_text, str):
                    raise ValueError("source and input must be strings")
                if len(stdin_text) > MAX_INPUT:
                    raise ValueError("input is too long")
                return self.send_json(200, run_program(source, stdin_text,
                                                       bool(body.get("optimized", True))))
        except (ValueError, KeyError, UnicodeDecodeError) as e:
            return self.send_json(400, {"error": "bad request: %s" % e})
        self.send_json(404, {"error": "not found"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print("TraceCode Studio running at http://%s:%d" % (host if host != "0.0.0.0" else "127.0.0.1", port), flush=True)
    if PASSWORD:
        print("Password protection is on. Enter the TRACECODE_PASSWORD value when the browser asks.", flush=True)
    elif host != "127.0.0.1":
        print("WARNING: listening on %s without a password. Set TRACECODE_PASSWORD before sharing this address." % host, flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
