#!/bin/sh
# Native end-to-end tests: TraceLang -> NASM -> ELF -> run.
# Each tests/native/NAME.tl is built twice (optimized and not) and its output compared
# with NAME.out. NAME.in (optional) is fed to standard input. divzero must fail with status 1.
cd "$(dirname "$0")/.." || exit 1
T=build/tracec
TMP=${TMPDIR:-/tmp}/tracecode_native_$$
mkdir -p "$TMP"
pass=0; fail=0

for src in tests/native/*.tl; do
    name=$(basename "$src" .tl)
    for mode in asm asm-opt; do
        asm="$TMP/$name.$mode.asm"; obj="$TMP/$name.$mode.o"; exe="$TMP/$name.$mode"
        if ! $T --$mode "$src" > "$asm" 2>"$TMP/err"; then
            echo "FAIL  $name ($mode): compile error: $(head -1 "$TMP/err")"; fail=$((fail+1)); continue
        fi
        if ! nasm -f elf64 "$asm" -o "$obj" 2>"$TMP/err"; then
            echo "FAIL  $name ($mode): nasm: $(head -1 "$TMP/err")"; fail=$((fail+1)); continue
        fi
        if ! ld "$obj" -o "$exe" 2>"$TMP/err"; then
            echo "FAIL  $name ($mode): ld: $(head -1 "$TMP/err")"; fail=$((fail+1)); continue
        fi
        input=/dev/null
        [ -f "tests/native/$name.in" ] && input="tests/native/$name.in"
        timeout 5 "$exe" < "$input" > "$TMP/out" 2>"$TMP/err"; rc=$?
        if [ "$name" = divzero ]; then
            if [ $rc -eq 1 ] && grep -q "division by zero" "$TMP/err"; then
                pass=$((pass+1)); echo "PASS  $name ($mode): runtime error reported, exit 1"
            else
                fail=$((fail+1)); echo "FAIL  $name ($mode): rc=$rc"
            fi
            continue
        fi
        if [ $rc -eq 0 ] && cmp -s "$TMP/out" "tests/native/$name.out"; then
            pass=$((pass+1)); echo "PASS  $name ($mode)"
        else
            fail=$((fail+1)); echo "FAIL  $name ($mode): rc=$rc"
            diff "tests/native/$name.out" "$TMP/out" | head -5
        fi
    done
done

rm -rf "$TMP"
echo
echo "Native passed: $pass   failed: $fail"
[ $fail -eq 0 ]
