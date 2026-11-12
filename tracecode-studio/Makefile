CC     = gcc
CFLAGS = -std=c11 -Wall -Wextra -g -D_POSIX_C_SOURCE=200809L -Iinclude -Ibuild -Wno-unused-function -DRUNTIME_PATH='"$(CURDIR)/runtime/runtime.asm"'
BUILD  = build
BIN    = $(BUILD)/tracec
SRCS   = src/main.c src/ast.c src/diag.c src/symtab.c src/semantic.c src/tac.c src/optimizer.c src/codegen_x86.c

all: $(BIN)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/parser.tab.c $(BUILD)/parser.tab.h: parser/parser.y | $(BUILD)
	bison -d -o $(BUILD)/parser.tab.c parser/parser.y

$(BUILD)/lex.yy.c: lexer/lexer.l $(BUILD)/parser.tab.h | $(BUILD)
	flex -o $(BUILD)/lex.yy.c lexer/lexer.l

$(BIN): $(SRCS) $(BUILD)/parser.tab.c $(BUILD)/lex.yy.c
	$(CC) $(CFLAGS) -o $@ $(SRCS) $(BUILD)/parser.tab.c $(BUILD)/lex.yy.c

test: all
	sh tests/run_tests.sh
	sh tests/run_native.sh

serve: all
	python3 backend/server.py

clean:
	rm -rf $(BUILD)

.PHONY: all test serve clean
