#ifndef SYMTAB_H
#define SYMTAB_H

#include <stdio.h>
#include "ast.h"

typedef enum { SYM_VAR, SYM_PARAM, SYM_FUNC } SymKind;

typedef struct Symbol {
    char *name;
    SymKind kind;
    Type type;              /* variable/parameter type, or function return type */
    char *scope;            /* name of the scope it was declared in */
    int depth;              /* 0 = global scope */
    int initialized;        /* definite-assignment state at the current point */
    int readonly;           /* loop variables cannot be assigned */
    int is_global;          /* declared outside any function: lives in .bss */
    char *init_text;        /* initial value shown in the symbol table, or NULL */
    int offset;             /* rbp offset: negative = local, positive = parameter */
    char *label;            /* assembly label for globals and functions */
    int line, col;
    struct Symbol *next_in_scope;
    /* functions only */
    int nparams;
    Type *ptypes;           /* parameter types, in declaration order */
    int frame_bytes;        /* size of local storage for this function */
} Symbol;

/* Scope management. The global scope exists after symtab_reset(). */
void symtab_reset(void);
void scope_push(const char *name, int line);
void scope_pop(void);
int  scope_depth(void);

/* Symbol management */
Symbol *symbol_declare(const char *name, SymKind kind, Type type, int line, int col);
Symbol *symbol_lookup(const char *name);          /* innermost visible scope first */
Symbol *symbol_lookup_current(const char *name);  /* current scope only */

/* Function context: locals declared while a function is entered get stack slots */
void    symtab_enter_func(Symbol *f);
void    symtab_leave_func(void);
Symbol *symtab_cur_func(void);

/* All symbols in declaration order (used by the dumper and by flow analysis) */
int      symtab_count(void);
Symbol  *symtab_get(int i);

/* Pretty-print the table: name, kind, type, scope, initial value, storage */
void symtab_dump(FILE *out, int tsv);   /* tsv != 0: tab-separated, one symbol per line */

#endif
