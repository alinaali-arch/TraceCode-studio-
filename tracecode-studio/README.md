# TraceCode Studio

TraceLang is a small Python-style language (indentation blocks, `start`/`end` programs,
explicit types). TraceCode Studio is a compiler for it: it translates TraceLang into
x86-64 NASM assembly, assembles and links it with the system tools, and runs it.

## Phases

| # | Phase | Where | Visible in the UI |
|---|---|---|---|
| 1 | Lexer (Flex, INDENT/DEDENT) | `lexer/lexer.l` | Tokens |
| 2 | Parser (Bison, precedence, AST) | `parser/parser.y` | AST, AST graph |
| 3 | Semantic analysis (types, scopes, definite assignment) | `src/semantic.c` | Console, types in AST |
| 4 | Symbol table (scope, type, value, storage) | `src/symtab.c` | Symbols |
| 5 | Three-address code | `src/tac.c` | TAC |
| 6 | Optimizer (folding, propagation, simplification, CSE, DCE) | `src/optimizer.c` | Optimizer |
| 7 | NASM code generation | `src/codegen_x86.c`, `runtime/runtime.asm` | Assembly |
| 8 | Assemble (nasm), link (ld), run | `backend/server.py` | Output |

## Requirements

Linux, or Windows with WSL2 (Ubuntu). Install once:

```bash
sudo apt update
sudo apt install -y build-essential flex bison nasm binutils graphviz python3 unzip
```

## Build, test, run

```bash
make            # build build/tracec
make test       # front-end tests (22) and native end-to-end tests (20)
make serve      # start the web interface on http://127.0.0.1:8000
```

Command line:

```bash
./build/tracec --tokens   examples/hello.tl
./build/tracec --ast      examples/control.tl
./build/tracec --symbols  examples/functions.tl
./build/tracec --tac      examples/functions.tl
./build/tracec --opt      examples/functions.tl      # TAC with optimization report
./build/tracec --asm-opt  examples/functions.tl > program.asm
nasm -f elf64 program.asm -o program.o && ld program.o -o program && ./program
```

## Web interface

- **Compile** (Ctrl+Enter) runs every phase. Each pipeline card shows its real status and metric (tokens, AST nodes, errors, TAC before and after, instructions). Click a card to see that phase's facts, errors and output.
- **Run** (Ctrl+Shift+Enter) builds the program with NASM and ld and runs it on this machine (5 second limit). The **Terminal** tab shows the input sent, the program output, and whether the run finished, hit a runtime error, or failed to build. Compile errors are reported separately in the Console.
- **Input** is typed in the Terminal tab, one value per line, and sent when the program starts. Each `write` reads the next line. Input is not interactive: it is sent all at once, because the server runs the program to completion.
- **AST** is an expandable tree. Nodes are coloured by category (declaration, control flow, statement, expression), and selecting a node shows its type and source position. The cursor line in the editor highlights the tokens and AST nodes that start on that line.
- **AST graph** is the animated Graphviz tree with an explanation for each node.
- **Assembly** shows line numbers and an instruction explainer. The code generator emits no source-line markers, so assembly is not linked to individual source lines; the panel says so.
- **Command palette** (Ctrl+K) runs any command, opens any tab, and loads any sample. **Keyboard shortcuts** are listed under the menu (...).
- **Panel** (sidebar button or Ctrl+B) has two tabs. *Saved programs* keeps named programs in this browser: Save (Ctrl+S), Open, Export as a .tl file, Delete, and Import a .tl file. *Settings* sets the editor font size (12 to 18 px). The setting is remembered in the browser.
- **Samples** are in the header. Each has a short description.
- **Layout**: the editor and output panes can be resized by dragging the divider (double-click resets it). Output tabs are grouped by compiler stage.
- **Theme** (Ctrl+Shift+L, or the sun/moon button) switches between dark (default) and light. The choice and the layout are remembered in the browser, and so is the unsent draft of the source.

Running a program executes a native binary on the machine where the server runs. Use the server
only on your own computer.

## Sharing the app with a link

The server runs compiled programs on the machine it runs on, so keep it protected whenever it is reachable from other computers.

**Option A: run on your own computer and share a temporary link (simplest for a demo)**

```
export TRACECODE_PASSWORD='choose-a-password'
make serve                                  # keep this terminal open
```

In a second terminal, open a tunnel to the server (install once with the cloudflared .deb from its GitHub releases):

```
cloudflared tunnel --url http://127.0.0.1:8000
```

It prints an https link. Send it with the password. The link works while both terminals stay open, and a new link is created each time you start the tunnel.

**Option B: Docker on a server or cloud host**

```
docker build -t tracecode-studio .
docker run -p 8000:8000 -e TRACECODE_PASSWORD='choose-a-password' tracecode-studio
```

`TRACECODE_PASSWORD` turns on HTTP Basic login (any user name, the password above). Without it, anyone with the address can run programs, so never publish the app without it. Set `HOST=0.0.0.0` only when a container or proxy must reach the server.

## Layout

```
include/   ast.h symtab.h semantic.h tac.h codegen.h common.h
src/       main.c ast.c diag.c symtab.c semantic.c tac.c optimizer.c codegen_x86.c
lexer/     lexer.l          parser/  parser.y
runtime/   runtime.asm      runtime library: print, input, float output, strings, errors
frontend/  index.html style.css app.js
backend/   server.py        local server (standard library only)
examples/  sample programs (hello, control, functions, fibonacci, primes, float_math)
tests/     run_tests.sh (front end), run_native.sh (end to end), valid/, invalid/, native/
```

## Limitations (version 1)

- `write` reads `int`, `float`, `bool` and `string`. A float line like `85.5` or `-3` is accepted; a bool line must be `true` or `false`.
- No `break` or `continue`, and no string concatenation.
- Functions cannot change global variables. They take parameters and return values.
- Float output has six decimal places.
- Input lines are limited to 511 characters.
- Not yet included: a step-by-step instruction simulator, a register visualizer, and an
  instruction-level debugger. Assembly is generated and executed natively, not simulated.
