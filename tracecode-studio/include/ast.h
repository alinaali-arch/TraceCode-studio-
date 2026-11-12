#ifndef AST_H
#define AST_H

#include <stdio.h>

typedef enum {
    N_PROGRAM,
    N_VARDECL,      /* name, type, e1 = initializer (optional) */
    N_ASSIGN,       /* name, e1 = value */
    N_WRITE,        /* name, type (optional: declare + read) */
    N_SHOW,         /* e1 = value */
    N_IF,           /* e1 = condition, body, orelse (elif is a nested N_IF) */
    N_WHILE,        /* e1 = condition, body */
    N_FOR,          /* name = loop var, e1 = start, e2 = end (inclusive), body */
    N_FUNC,         /* name, type (return type, NULL = none), args = params, body */
    N_PARAM,        /* name, type */
    N_RETURN,       /* e1 = value (optional) */
    N_CALL_STMT,    /* e1 = N_CALL */
    N_BINOP,        /* name = operator, e1, e2 */
    N_UNOP,         /* name = operator, e1 */
    N_INT,          /* ival */
    N_FLOAT,        /* fval */
    N_STRING,       /* name = literal contents (escapes already processed) */
    N_BOOL,         /* ival = 0 or 1 */
    N_IDENT,        /* name */
    N_CALL          /* name, args */
} NodeKind;

/* Static types of TraceLang values. Filled in by the semantic analyzer. */
typedef enum {
    TY_UNKNOWN,     /* not yet inferred, or after an error */
    TY_INT,
    TY_FLOAT,
    TY_STRING,
    TY_BOOL,
    TY_VOID         /* function without a return type */
} Type;

struct Symbol;

typedef struct Node {
    NodeKind kind;
    int line, col;
    char *name;             /* identifier, operator, or string literal */
    char *type;             /* declared type name, or NULL */
    long long ival;
    double fval;
    struct Node *e1, *e2;   /* expression children */
    struct Node *args;      /* list: call arguments or function parameters */
    struct Node *body;      /* list: statements of a suite */
    struct Node *orelse;    /* list: else branch */
    struct Node *next;      /* next sibling in a list */
    Type ty;                /* inferred type (semantic analysis) */
    struct Symbol *sym;     /* resolved symbol (semantic analysis), or NULL */
} Node;

Node *new_node(NodeKind kind, int line, int col);
Node *append(Node *list, Node *n);

const char *type_name(Type t);
Type type_from_name(const char *s);

/* Visualization: indented text tree and Graphviz DOT graph */
void ast_print_text(FILE *out, const Node *n, int depth);
void ast_print_dot(FILE *out, const Node *root);

#endif
