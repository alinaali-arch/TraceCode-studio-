#ifndef TAC_H
#define TAC_H

#include <stdio.h>
#include "ast.h"
#include "symtab.h"

/* Operands of three-address code */
typedef enum { OP_NONE, OP_VAR, OP_TEMP, OP_INT, OP_FLOAT, OP_BOOL, OP_STR } OpKind;

typedef struct {
    OpKind k;
    Symbol *sym;        /* OP_VAR */
    int temp;           /* OP_TEMP: index within its unit */
    long long i;        /* OP_INT, OP_BOOL */
    double f;           /* OP_FLOAT */
    int str;            /* OP_STR: index into the string pool */
} Operand;

typedef enum {
    I_COPY,     /* dst = a                       */
    I_BIN,      /* dst = a <bop> b               */
    I_UN,       /* dst = <bop> a                 */
    I_ITOF,     /* dst = (float) a              */
    I_LABEL,    /* label L:                      */
    I_GOTO,     /* goto L                        */
    I_IFFALSE,  /* if a == false goto L          */
    I_PARAM,    /* push a as the next argument   */
    I_CALL,     /* dst = call fname (nargs)      */
    I_RET,      /* return a                      */
    I_RETV,     /* return (no value)             */
    I_SHOW,     /* show a                        */
    I_READ      /* dst = read input (ty)         */
} Opc;

typedef struct Instr {
    Opc op;
    const char *bop;        /* operator text for I_BIN / I_UN */
    Type ty;                /* operand type (int, float, string, bool) */
    Type rty;               /* result type */
    Operand dst, a, b;
    int label;              /* I_LABEL, I_GOTO, I_IFFALSE */
    int nargs;              /* I_CALL */
    char *fname;            /* I_CALL */
    int dead;               /* marked by the optimizer */
    struct Instr *next;
} Instr;

/* One unit of code: the main program or one function */
typedef struct Unit {
    char *name;             /* "main" or the function name */
    Symbol *fsym;           /* NULL for main */
    Instr *first, *last;
    int ntemps;
    int ninstr;
    struct Unit *next;
} Unit;

/* Generation: fills the unit list from a semantically checked program */
Unit *tac_generate(Node *program);

/* String literal pool shared by the code generator */
int         tac_string_count(void);
const char *tac_string(int id);

/* Optimization (src/optimizer.c). Returns a report via the struct below. */
typedef struct {
    int before, after;                  /* instruction counts */
    int folded, propagated, simplified, cse, dead;
} OptReport;
void optimize_unit(Unit *u, OptReport *r);

/* Printing */
void tac_print_unit(FILE *out, const Unit *u);
int  tac_count(const Unit *u);
char *tac_operand_text(const Operand *o);
char *tac_instr_text(const Instr *i);   /* one instruction as text (caller frees) */

#endif
