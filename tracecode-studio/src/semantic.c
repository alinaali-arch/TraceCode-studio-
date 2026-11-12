#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ast.h"
#include "common.h"
#include "semantic.h"
#include "symtab.h"

/*
 * Error format (parsed by backend/server.py):
 *   [Semantic error] line L, col C: explanation | Fix: correction
 *   [Type error] line L, col C: explanation | Fix: correction
 */

static int nerrors = 0;

static void sem_err(const char *cat, int line, int col, const char *fix, const char *fmt, ...)
{
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    fprintf(stderr, "[%s error] line %d, col %d: %s", cat, line, col, msg);
    if (fix) fprintf(stderr, " | Fix: %s", fix);
    fputc('\n', stderr);
    nerrors++;
}

static int is_numeric(Type t) { return t == TY_INT || t == TY_FLOAT; }

/* "an int", "a string": English article for a type name */
static const char *article(Type t)
{
    return t == TY_INT ? "an" : "a";
}

/* int widens to float implicitly; everything else must match exactly */
static int assignable(Type dst, Type src)
{
    if (dst == src) return 1;
    return dst == TY_FLOAT && src == TY_INT;
}

/* Text of a literal initializer, shown as the "initial value" in the symbol table */
static char *literal_text(const Node *e)
{
    char buf[256];
    switch (e->kind) {
    case N_INT:    snprintf(buf, sizeof buf, "%lld", e->ival); break;
    case N_FLOAT:  snprintf(buf, sizeof buf, "%g", e->fval); break;
    case N_STRING: snprintf(buf, sizeof buf, "\"%s\"", e->name); break;
    case N_BOOL:   snprintf(buf, sizeof buf, "%s", e->ival ? "true" : "false"); break;
    case N_UNOP:
        if (e->e1 && e->e1->kind == N_INT && strcmp(e->name, "-") == 0) {
            snprintf(buf, sizeof buf, "-%lld", e->e1->ival);
            break;
        }
        return strdup("(computed at run time)");
    default:
        return strdup("(computed at run time)");
    }
    return strdup(buf);
}

/* ---------- Definite assignment: snapshots of "is initialized" flags ---------- */

static char *snapshot(int *n)
{
    *n = symtab_count();
    char *b = malloc(*n + 1);
    for (int i = 0; i < *n; i++) b[i] = (char)symtab_get(i)->initialized;
    return b;
}

static void restore(const char *b, int n)
{
    for (int i = 0; i < n; i++) symtab_get(i)->initialized = b[i];
}

/* ---------- Forward declarations ---------- */

static void sem_stmt(Node *s);
static Type sem_expr(Node *e);

/* Expression used where a value is required: functions with no return type are rejected */
static Type value_expr(Node *e)
{
    Type t = sem_expr(e);
    if (t == TY_VOID) {
        sem_err("Type", e->line, e->col,
                "remove this call, or give the function a return type such as '-> int'",
                "function '%s' returns no value, so it cannot be used in an expression", e->name);
        e->ty = TY_UNKNOWN;
        return TY_UNKNOWN;
    }
    return t;
}

/* target describes the receiving place, e.g. "variable 'x'" or "argument 1 of 'add'" */
static void check_assign(Type dst, Type src, Node *at, const char *target)
{
    if (dst == TY_UNKNOWN || src == TY_UNKNOWN) return;      /* already reported */
    if (assignable(dst, src)) return;
    char fix[256];
    if (dst == TY_INT && src == TY_FLOAT)
        snprintf(fix, sizeof fix, "use an int value, or declare the target as float");
    else
        snprintf(fix, sizeof fix, "give it %s %s value, or change its declared type to %s",
                 article(dst), type_name(dst), type_name(src));
    sem_err("Type", at->line, at->col, fix,
            "cannot use %s %s value for %s, which has type %s",
            article(src), type_name(src), target, type_name(dst));
}

/* Returns 0 (after reporting) if the symbol may not be assigned here */
static int check_writable(Symbol *sym, Node *at)
{
    if (sym->kind == SYM_FUNC) {
        sem_err("Semantic", at->line, at->col, "use a different name for the variable",
                "'%s' is a function and cannot be assigned", sym->name);
        return 0;
    }
    if (sym->readonly) {
        sem_err("Semantic", at->line, at->col,
                "use a separate variable, for example 'total = total + i'",
                "loop variable '%s' cannot be changed inside its loop", sym->name);
        return 0;
    }
    if (sym->is_global && symtab_cur_func()) {
        sem_err("Semantic", at->line, at->col,
                "pass the value in as a parameter and return the new value instead",
                "a function cannot change the global variable '%s' (TraceLang v1 rule)", sym->name);
        return 0;
    }
    return 1;
}

/* Declares a name in the current scope, reporting duplicates */
static Symbol *declare_checked(Node *at, const char *name, SymKind kind, Type type)
{
    Symbol *prev = symbol_lookup_current(name);
    if (prev) {
        char fix[128];
        snprintf(fix, sizeof fix, "choose another name, for example '%s2'", name);
        sem_err("Semantic", at->line, at->col, fix,
                "duplicate declaration of '%s' (first declared on line %d)", name, prev->line);
        return NULL;
    }
    return symbol_declare(name, kind, type, at->line, at->col);
}

/* Function calls: argument count and types, return type */
static Type sem_call(Node *c)
{
    Symbol *f = symbol_lookup(c->name);
    c->sym = f;

    if (!f) {
        sem_err("Semantic", c->line, c->col,
                "define the function above this line before calling it",
                "call to undefined function '%s'", c->name);
    } else if (f->kind != SYM_FUNC) {
        sem_err("Semantic", c->line, c->col, "call a function here, or rename the variable",
                "'%s' is a variable, not a function", c->name);
        f = NULL;
        c->sym = NULL;
    }

    int argc = 0;
    for (Node *a = c->args; a; a = a->next, argc++) {
        Type at = value_expr(a);
        if (f && argc < f->nparams) {
            char what[128];
            snprintf(what, sizeof what, "argument %d of '%s'", argc + 1, c->name);
            check_assign(f->ptypes[argc], at, a, what);
        }
    }

    if (f && argc != f->nparams) {
        char fix[128];
        snprintf(fix, sizeof fix, "pass exactly %d argument(s)", f->nparams);
        sem_err("Type", c->line, c->col, fix,
                "function '%s' expects %d argument(s) but got %d", c->name, f->nparams, argc);
    }

    c->ty = (f && f->kind == SYM_FUNC) ? f->type : TY_UNKNOWN;
    return c->ty;
}

static Type sem_expr(Node *e)
{
    if (!e) return TY_UNKNOWN;
    switch (e->kind) {
    case N_INT:    e->ty = TY_INT; break;
    case N_FLOAT:  e->ty = TY_FLOAT; break;
    case N_STRING: e->ty = TY_STRING; break;
    case N_BOOL:   e->ty = TY_BOOL; break;

    case N_IDENT: {
        Symbol *s = symbol_lookup(e->name);
        if (!s) {
            sem_err("Semantic", e->line, e->col,
                    "declare it first, for example '<name>: int = 0'",
                    "undeclared variable '%s'", e->name);
            e->ty = TY_UNKNOWN;
            break;
        }
        if (s->kind == SYM_FUNC) {
            sem_err("Semantic", e->line, e->col, "call it with parentheses, for example 'name()'",
                    "'%s' is a function and cannot be used as a value", e->name);
            e->ty = TY_UNKNOWN;
            break;
        }
        e->sym = s;
        if (!s->initialized) {
            sem_err("Semantic", e->line, e->col,
                    "assign a value to it before this line, on every path that reaches here",
                    "variable '%s' is used before it is assigned", e->name);
        }
        e->ty = s->type;
        break;
    }

    case N_CALL:
        e->ty = sem_call(e);
        break;

    case N_UNOP: {
        Type t = value_expr(e->e1);
        if (strcmp(e->name, "not") == 0) {
            if (t != TY_UNKNOWN && t != TY_BOOL)
                sem_err("Type", e->line, e->col,
                        "compare the value first, for example 'not (x > 0)'",
                        "'not' needs a bool operand, got %s", type_name(t));
            e->ty = TY_BOOL;
        } else {                                   /* unary minus */
            if (t != TY_UNKNOWN && !is_numeric(t))
                sem_err("Type", e->line, e->col, "use an int or float operand with '-'",
                        "unary '-' needs a numeric operand, got %s", type_name(t));
            e->ty = is_numeric(t) ? t : TY_UNKNOWN;
        }
        break;
    }

    case N_BINOP: {
        Type l = value_expr(e->e1);
        Type r = value_expr(e->e2);
        const char *op = e->name;
        e->ty = TY_UNKNOWN;
        if (l == TY_UNKNOWN || r == TY_UNKNOWN) break;     /* already reported */

        if (strcmp(op, "and") == 0 || strcmp(op, "or") == 0) {
            if (l != TY_BOOL || r != TY_BOOL)
                sem_err("Type", e->line, e->col,
                        "use comparisons such as 'x > 0' to produce bool values",
                        "'%s' needs bool operands, got %s and %s", op, type_name(l), type_name(r));
            e->ty = TY_BOOL;
        } else if (strcmp(op, "==") == 0 || strcmp(op, "!=") == 0) {
            if (!((is_numeric(l) && is_numeric(r)) || l == r))
                sem_err("Type", e->line, e->col, "compare values of the same type",
                        "cannot compare %s with %s", type_name(l), type_name(r));
            e->ty = TY_BOOL;
        } else if (strcmp(op, "<") == 0 || strcmp(op, ">") == 0 ||
                   strcmp(op, "<=") == 0 || strcmp(op, ">=") == 0) {
            if (!(is_numeric(l) && is_numeric(r)))
                sem_err("Type", e->line, e->col, "order comparisons work on int and float values",
                        "'%s' needs numeric operands, got %s and %s", op, type_name(l), type_name(r));
            e->ty = TY_BOOL;
        } else {                                   /* + - * / % */
            if (l == TY_STRING || r == TY_STRING) {
                if (strcmp(op, "+") == 0 && l == TY_STRING && r == TY_STRING)
                    sem_err("Type", e->line, e->col,
                            "print the strings with separate 'show' statements",
                            "string concatenation with '+' is not supported in TraceLang v1");
                else
                    sem_err("Type", e->line, e->col, "use int or float operands",
                            "operator '%s' cannot be used with a string", op);
            } else if (!is_numeric(l) || !is_numeric(r)) {
                sem_err("Type", e->line, e->col, "use int or float operands",
                        "operator '%s' needs numeric operands, got %s and %s",
                        op, type_name(l), type_name(r));
            } else if (strcmp(op, "%") == 0) {
                if (l != TY_INT || r != TY_INT)
                    sem_err("Type", e->line, e->col, "use int values with '%'",
                            "'%%' works only on int operands, got %s and %s", type_name(l), type_name(r));
                e->ty = TY_INT;
            } else {
                if (strcmp(op, "/") == 0 && e->e2->kind == N_INT && e->e2->ival == 0)
                    sem_err("Semantic", e->line, e->col, "use a non-zero divisor",
                            "division by zero");
                e->ty = (l == TY_FLOAT || r == TY_FLOAT) ? TY_FLOAT : TY_INT;
            }
        }
        break;
    }

    default:
        break;
    }
    return e->ty;
}

/* True if every path through the list ends in a return */
static int always_returns(const Node *l)
{
    for (const Node *n = l; n; n = n->next) {
        if (n->kind == N_RETURN) return 1;
        if (n->kind == N_IF && n->orelse && always_returns(n->body) && always_returns(n->orelse))
            return 1;
    }
    return 0;
}

static void sem_block(Node *list, const char *what, int line)
{
    if (!list) return;
    scope_push(what, line);
    for (Node *p = list; p; p = p->next) sem_stmt(p);
    scope_pop();
}

static void sem_stmt(Node *s)
{
    switch (s->kind) {

    case N_VARDECL: {
        Type dt = type_from_name(s->type);
        Symbol *sym = declare_checked(s, s->name, SYM_VAR, dt);   /* declare first: x: int = x fails */
        if (s->e1) {
            Type et = value_expr(s->e1);
            char target[160];
            snprintf(target, sizeof target, "variable '%s'", s->name);
            check_assign(dt, et, s->e1, target);
            if (sym) {
                sym->initialized = 1;
                sym->init_text = literal_text(s->e1);
            }
        }
        if (sym) s->sym = sym;
        break;
    }

    case N_ASSIGN: {
        Symbol *sym = symbol_lookup(s->name);
        Type et = value_expr(s->e1);
        if (!sym) {
            sem_err("Semantic", s->line, s->col,
                    "declare it first, for example '<name>: int = 0'",
                    "assignment to undeclared variable '%s'", s->name);
            break;
        }
        s->sym = sym;
        if (!check_writable(sym, s)) break;
        char target[160];
        snprintf(target, sizeof target, "variable '%s'", s->name);
        check_assign(sym->type, et, s->e1, target);
        sym->initialized = 1;
        if (!sym->init_text) sym->init_text = strdup("(assigned later)");
        break;
    }

    case N_WRITE: {
        Symbol *sym;
        if (s->type) {
            Type t = type_from_name(s->type);
            if (t != TY_INT && t != TY_STRING && t != TY_FLOAT && t != TY_BOOL)
                sem_err("Type", s->line, s->col, "read an int, float, bool or string with 'write'",
                        "'write' supports int, float, bool and string input, not %s", s->type);
            sym = declare_checked(s, s->name, SYM_VAR, t);
            if (sym) {
                sym->initialized = 1;
                sym->init_text = strdup("(read from input)");
            }
        } else {
            sym = symbol_lookup(s->name);
            if (!sym) {
                sem_err("Semantic", s->line, s->col,
                        "declare it first, for example 'write <name>: int'",
                        "'write' into undeclared variable '%s'", s->name);
                break;
            }
            if (check_writable(sym, s)) {
                sym->initialized = 1;
                if (!sym->init_text) sym->init_text = strdup("(read from input)");
            }
        }
        s->sym = sym;
        break;
    }

    case N_SHOW:
        value_expr(s->e1);
        break;

    case N_IF: {
        Type ct = value_expr(s->e1);
        if (ct != TY_UNKNOWN && ct != TY_BOOL)
            sem_err("Type", s->e1->line, s->e1->col,
                    "compare the value, for example 'if x != 0:'",
                    "'if' condition must be bool, got %s", type_name(ct));

        int n0, n1, n2;
        char *before = snapshot(&n0);
        sem_block(s->body, "if branch", s->line);
        char *after_then = snapshot(&n1);
        restore(before, n0);
        sem_block(s->orelse, "else branch", s->line);
        char *after_else = snapshot(&n2);

        /* After the if: a variable is initialized only if both branches initialize it */
        int m = n1 < n2 ? n1 : n2;
        for (int i = 0; i < m; i++)
            symtab_get(i)->initialized = after_then[i] && after_else[i];

        free(before); free(after_then); free(after_else);
        break;
    }

    case N_WHILE: {
        Type ct = value_expr(s->e1);
        if (ct != TY_UNKNOWN && ct != TY_BOOL)
            sem_err("Type", s->e1->line, s->e1->col,
                    "compare the value, for example 'while i <= 5:'",
                    "'while' condition must be bool, got %s", type_name(ct));
        int n0;
        char *before = snapshot(&n0);
        sem_block(s->body, "while body", s->line);
        /* The body may run zero times, so its assignments do not count after the loop */
        restore(before, n0);
        free(before);
        break;
    }

    case N_FOR: {
        Type st = value_expr(s->e1);
        Type et = value_expr(s->e2);
        if ((st != TY_UNKNOWN && st != TY_INT) || (et != TY_UNKNOWN && et != TY_INT))
            sem_err("Type", s->line, s->col, "use int values for the loop range",
                    "'for' range bounds must be int, got %s to %s", type_name(st), type_name(et));

        scope_push("for loop", s->line);
        Symbol *lv = declare_checked(s, s->name, SYM_VAR, TY_INT);
        if (lv) {
            lv->initialized = 1;
            lv->readonly = 1;
            lv->init_text = strdup("(set by the loop)");
            s->sym = lv;
        }
        int n0;
        char *before = snapshot(&n0);
        sem_block(s->body, "for body", s->line);
        restore(before, n0);
        free(before);
        scope_pop();
        break;
    }

    case N_FUNC: {
        if (scope_depth() != 0 || symtab_cur_func()) {
            sem_err("Semantic", s->line, s->col,
                    "move the function to the top level of the program",
                    "functions can only be declared at the top level");
            break;
        }
        Type rt = s->type ? type_from_name(s->type) : TY_VOID;
        Symbol *f = declare_checked(s, s->name, SYM_FUNC, rt);
        if (!f) break;                                  /* duplicate name, already reported */
        s->sym = f;

        int n = 0;
        for (Node *p = s->args; p; p = p->next) n++;
        f->nparams = n;
        f->ptypes = calloc(n ? n : 1, sizeof *f->ptypes);

        symtab_enter_func(f);
        scope_push(strcat(strcpy(malloc(strlen(s->name) + 10), "function "), s->name), s->line);

        int i = 0;
        for (Node *p = s->args; p; p = p->next, i++) {
            Type pt = type_from_name(p->type);
            f->ptypes[i] = pt;
            Symbol *ps = declare_checked(p, p->name, SYM_PARAM, pt);
            if (ps) {
                ps->initialized = 1;
                /* The caller pushes arguments left to right, so the last one is nearest rbp+16 */
                ps->offset = 16 + 8 * (n - 1 - i);
                ps->init_text = strdup("(passed by caller)");
                p->sym = ps;
            }
        }

        for (Node *b = s->body; b; b = b->next) sem_stmt(b);

        if (rt != TY_VOID && !always_returns(s->body))
            sem_err("Type", s->line, s->col, "end the function with 'return <value>'",
                    "function '%s' may finish without returning %s %s value", s->name, article(rt), type_name(rt));

        scope_pop();
        symtab_leave_func();
        break;
    }

    case N_RETURN: {
        Symbol *f = symtab_cur_func();
        if (!f) {
            sem_err("Semantic", s->line, s->col, "remove it, or move it inside a function",
                    "'return' outside of a function");
            if (s->e1) value_expr(s->e1);
            break;
        }
        if (s->e1) {
            Type t = value_expr(s->e1);
            if (f->type == TY_VOID)
                sem_err("Type", s->line, s->col,
                        "remove the value, or add '-> <type>' to the function header",
                        "function '%s' has no return type, so it cannot return a value", f->name);
            else {
                char target[160];
                snprintf(target, sizeof target, "the return of '%s'", f->name);
                check_assign(f->type, t, s->e1, target);
            }
        } else if (f->type != TY_VOID) {
            sem_err("Type", s->line, s->col, "write 'return <value>'",
                    "function '%s' must return %s %s value", f->name, article(f->type), type_name(f->type));
        }
        break;
    }

    case N_CALL_STMT:
        sem_call(s->e1);
        break;

    default:
        break;
    }
}

int sem_analyze(Node *program)
{
    nerrors = 0;
    symtab_reset();
    for (Node *p = program->body; p; p = p->next) sem_stmt(p);
    return nerrors;
}
