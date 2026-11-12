#!/bin/sh
# Test runner for the front end: lexer, parser, AST, semantic analysis, symbol table.
#   valid programs    -> every phase succeeds (exit 0) and expected facts appear in the output
#   invalid programs  -> the right error category and message fragment is reported
cd "$(dirname "$0")/.." || exit 1
T=build/tracec
pass=0; fail=0

ok()  { pass=$((pass+1)); echo "PASS  $1"; }
bad() { fail=$((fail+1)); echo "FAIL  $1"; }

# ---- valid programs: all phases must succeed --------------------------------
for f in examples/*.tl tests/valid/*.tl; do
    if $T --tokens "$f" >/dev/null 2>&1 && $T --ast "$f" >/dev/null 2>&1 && \
       $T --check "$f" >/dev/null 2>&1; then ok "all phases: $f"; else bad "all phases: $f"; fi
done

# ---- expected facts in AST and symbol table ----------------------------------
out=$($T --ast tests/valid/precedence.tl 2>/dev/null)
echo "$out" | sed -n '/VarDecl a/,/VarDecl b/p' | grep -q "BinOp \*" \
  && ok "precedence: 2 + 3 * 4 has * under +" || bad "precedence: 2 + 3 * 4 has * under +"

out=$($T --ast examples/functions.tl 2>/dev/null)
echo "$out" | grep -q "Call add.*<int>" \
  && ok "AST shows inferred type <int> on the call" || bad "AST shows inferred type <int> on the call"

out=$($T --symbols examples/functions.tl 2>/dev/null)
echo "$out" | grep -q "add .*function.*(int, int) -> int.*code  fn_add" \
  && ok "symbols: function signature and code label" || bad "symbols: function signature and code label"
echo "$out" | grep -q "a .*parameter.*stack \[rbp+24\]" \
  && ok "symbols: first parameter at [rbp+24]" || bad "symbols: first parameter at [rbp+24]"
echo "$out" | grep -q "result .*variable.*stack \[rbp-8\]" \
  && ok "symbols: first local at [rbp-8]" || bad "symbols: first local at [rbp-8]"

# ---- invalid programs: syntax and lexical errors ----------------------------
for f in tests/invalid/bad_*.tl; do
    err=$($T --ast "$f" 2>&1 >/dev/null); rc=$?
    if [ $rc -ne 0 ] && echo "$err" | grep -qE '^\[(Lexical|Syntax) error\] line [0-9]+, col [0-9]+:'; then
        ok "reject $f"
    else
        bad "reject $f"
    fi
done

# ---- invalid programs: semantic and type errors -----------------------------
expect() { # file, expected category, expected message fragment
    err=$($T --check "$1" 2>&1 >/dev/null); rc=$?
    if [ $rc -ne 0 ] && echo "$err" | grep -q "\[$2 error\]" && echo "$err" | grep -q -- "$3"; then
        ok "reject $1 ($2: $3)"
    else
        bad "reject $1 (expected $2: $3) got: $err"
    fi
}
expect tests/invalid/sem_undeclared.tl     Semantic "undeclared variable 'count'"
expect tests/invalid/sem_type_mismatch.tl  Type     "cannot use a string value for variable 'age'"
expect tests/invalid/sem_duplicate.tl      Semantic "duplicate declaration of 'x'"
expect tests/invalid/sem_uninit.tl         Semantic "used before it is assigned"
expect tests/invalid/sem_if_uninit.tl      Semantic "variable 'x' is used before it is assigned"
expect tests/invalid/sem_func_args.tl      Type     "expects 2 argument(s) but got 1"
expect tests/invalid/sem_missing_return.tl Type     "may finish without returning an int value"
expect tests/invalid/sem_global_write.tl   Semantic "cannot change the global variable 'total'"
expect tests/invalid/sem_bool_cond.tl      Type     "condition must be bool, got int"

echo
echo "Passed: $pass   Failed: $fail"
[ $fail -eq 0 ]
