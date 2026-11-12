#ifndef COMMON_H
#define COMMON_H

#include <stdio.h>

/* Position and text of the most recent token returned by yylex() (defined in lexer.l) */
extern int last_tok_line;
extern int last_tok_col;
extern const char *last_tok_txt;

/* Print a uniform diagnostic to stderr and terminate with status 1.
 * Format is parsed by backend/server.py: "[<Phase> error] line L, col C: message" */
void fatal(const char *phase, int line, int col, const char *fmt, ...);

#endif
