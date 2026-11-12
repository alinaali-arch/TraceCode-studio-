#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common.h"
#include "tac.h"

/* ---------- String pool ---------- */

static char **strings = NULL;
static int nstrings = 0, capstrings = 0;

static int intern_string(const char *s)
{
    if (nstrings == capstrings) {
        capstrings = capstrings ? capstrings * 2 : 16;
        strings = realloc(strings, capstrings * sizeof *strings);
    }
    strings[nstrings] = strdup(s);
    return nstrings++;
}

int tac_string_count(void)     { return nstrings; }
const char *tac_string(int id) { return strings[id]; }

/* ---------- Construction helpers ---------- */

static Unit *cur;
static Unit *units_head, *units_tail;
static int next_label = 0;

static Operand none(void) { Operand o = {OP_NONE}; return o; }

static Operand temp_op(void)
{
    Operand o = none();
    o.k = OP_TEMP;
    o.temp = cur->ntemps++;
    return o;
}

static Operand var_op(Symbol *s)
{
    Operand o = none();
    o.k = OP_VAR;
    o.sym = s;
    return o;
}

static Instr *emit(Opc op)
{
    Instr *i = calloc(1, sizeof *i);
    i->op = op;
    i->dst = i->a = i->b = none();
    if (cur->last) cur->last->next = i;
    else cur->first = i;
    cur->last = i;
    cur->ninstr++;
    return i;
}

static int new_label(void) { return next_label++; }

static void emit_label(int l)
{
    Instr *i = emit(I_LABEL);
    i->label = l;
}

static Type expr_type(const Node *e) { return e->ty; }

/* Converts a value to float when an int is used where a float is required */
static Operand coerce(Operand v, Type from, Type to)
{
    if (from == TY_INT && to == TY_FLOAT) {
        Operand t = temp_op();
        Instr *i = emit(I_ITOF);
        i->dst = t;
        i->a = v;
        i->rty = TY_FLOAT;
        return t;
    }
    return v;
}

static Operand gen_expr(Node *e);

static Operand gen_call(Node *c, int want_value)
{
    Symbol *f = c->sym;
    int n = 0;
    for (Node *a = c->args; a; a = a->next, n++) {
        Operand v = gen_expr(a);
        Type pt = (f && n < f->nparams) ? f->ptypes[n] : a->ty;
        v = coerce(v, a->ty, pt);
        Instr *p = emit(I_PARAM);
        p->a = v;
        p->ty = pt;
    }
    Instr *call = emit(I_CALL);
    call->fname = c->name;
    call->nargs = n;
    call->rty = c->ty;
    if (want_value && c->ty != TY_VOID) {
        call->dst = temp_op();
        return call->dst;
    }
    return none();
}

static Operand gen_expr(Node *e)
{
    switch (e->kind) {
    case N_INT:    { Operand o = none(); o.k = OP_INT;  o.i = e->ival; return o; }
    case N_BOOL:   { Operand o = none(); o.k = OP_BOOL; o.i = e->ival; return o; }
    case N_FLOAT:  { Operand o = none(); o.k = OP_FLOAT; o.f = e->fval; return o; }
    case N_STRING: { Operand o = none(); o.k = OP_STR;  o.str = intern_string(e->name); return o; }
    case N_IDENT:  return var_op(e->sym);
    case N_CALL:   return gen_call(e, 1);

    case N_UNOP: {
        Operand a = gen_expr(e->e1);
        Operand t = temp_op();
        Instr *i = emit(I_UN);
        i->bop = strcmp(e->name, "not") == 0 ? "not" : "-";
        i->ty = e->e1->ty;
        i->rty = e->ty;
        i->dst = t;
        i->a = a;
        return t;
    }

    case N_BINOP: {
        const char *op = e->name;
        Operand t = temp_op();

        if (strcmp(op, "and") == 0 || strcmp(op, "or") == 0) {
            /* short-circuit: the right operand runs only when needed */
            int lend = new_label();
            Operand a = gen_expr(e->e1);
            Instr *c = emit(I_COPY);  c->dst = t; c->a = a; c->ty = TY_BOOL;
            if (strcmp(op, "and") == 0) {
                Instr *j = emit(I_IFFALSE);  j->a = t; j->label = lend;
            } else {
                Operand n = temp_op();
                Instr *x = emit(I_UN);  x->bop = "not"; x->ty = TY_BOOL; x->rty = TY_BOOL; x->dst = n; x->a = t;
                Instr *j = emit(I_IFFALSE);  j->a = n; j->label = lend;
            }
            Operand b = gen_expr(e->e2);
            Instr *c2 = emit(I_COPY);  c2->dst = t; c2->a = b; c2->ty = TY_BOOL;
            emit_label(lend);
            return t;
        }

        Operand a = gen_expr(e->e1);
        Operand b = gen_expr(e->e2);
        Type l = e->e1->ty, r = e->e2->ty;
        Type opty;
        if (l == TY_FLOAT || r == TY_FLOAT) opty = TY_FLOAT;
        else if (l == TY_STRING || r == TY_STRING) opty = TY_STRING;
        else if (l == TY_BOOL || r == TY_BOOL) opty = TY_BOOL;
        else opty = TY_INT;

        if (strcmp(op, "%") != 0 && opty != TY_STRING && opty != TY_BOOL) {
            a = coerce(a, l, TY_FLOAT == opty ? TY_FLOAT : l);
            b = coerce(b, r, TY_FLOAT == opty ? TY_FLOAT : r);
        }
        Instr *i = emit(I_BIN);
        i->bop = op;
        i->ty = opty;
        i->rty = e->ty;
        i->dst = t;
        i->a = a;
        i->b = b;
        return t;
    }

    default:
        return none();
    }
}

static void gen_stmt(Node *s);

static void gen_block(Node *list)
{
    for (Node *p = list; p; p = p->next) gen_stmt(p);
}

static void gen_stmt(Node *s)
{
    switch (s->kind) {

    case N_VARDECL:
    case N_ASSIGN: {
        if (!s->e1 || !s->sym) break;
        Operand v = gen_expr(s->e1);
        v = coerce(v, s->e1->ty, s->sym->type);
        Instr *c = emit(I_COPY);
        c->dst = var_op(s->sym);
        c->a = v;
        c->ty = s->sym->type;
        break;
    }

    case N_WRITE: {
        if (!s->sym) break;
        Instr *r = emit(I_READ);
        r->dst = var_op(s->sym);
        r->ty = s->sym->type;
        break;
    }

    case N_SHOW: {
        Operand v = gen_expr(s->e1);
        Instr *i = emit(I_SHOW);
        i->a = v;
        i->ty = s->e1->ty;
        break;
    }

    case N_CALL_STMT:
        gen_call(s->e1, 0);
        break;

    case N_RETURN: {
        Symbol *f = cur->fsym;
        if (s->e1) {
            Operand v = gen_expr(s->e1);
            v = coerce(v, s->e1->ty, f ? f->type : s->e1->ty);
            Instr *i = emit(I_RET);
            i->a = v;
        } else {
            emit(I_RETV);
        }
        break;
    }

    case N_IF: {
        int lelse = new_label(), lend = new_label();
        Operand c = gen_expr(s->e1);
        Instr *j = emit(I_IFFALSE);
        j->a = c;
        j->label = s->orelse ? lelse : lend;
        gen_block(s->body);
        if (s->orelse) {
            Instr *g = emit(I_GOTO);
            g->label = lend;
            emit_label(lelse);
            gen_block(s->orelse);
        }
        emit_label(lend);
        break;
    }

    case N_WHILE: {
        int ltop = new_label(), lend = new_label();
        emit_label(ltop);
        Operand c = gen_expr(s->e1);
        Instr *j = emit(I_IFFALSE);
        j->a = c;
        j->label = lend;
        gen_block(s->body);
        Instr *g = emit(I_GOTO);
        g->label = ltop;
        emit_label(lend);
        break;
    }

    case N_FOR: {
        /* for i in a to b: the end value is evaluated once, before the loop */
        int ltop = new_label(), lend = new_label();
        Operand start = gen_expr(s->e1);
        Operand end = gen_expr(s->e2);
        Operand endt = temp_op();
        Instr *ce = emit(I_COPY);
        ce->dst = endt; ce->a = end; ce->ty = TY_INT;

        Instr *ci = emit(I_COPY);
        ci->dst = var_op(s->sym); ci->a = start; ci->ty = TY_INT;

        emit_label(ltop);
        Operand cond = temp_op();
        Instr *cmp = emit(I_BIN);
        cmp->bop = "<=";
        cmp->ty = TY_INT;
        cmp->rty = TY_BOOL;
        cmp->dst = cond;
        cmp->a = var_op(s->sym);
        cmp->b = endt;
        Instr *j = emit(I_IFFALSE);
        j->a = cond;
        j->label = lend;

        gen_block(s->body);

        Operand one = none(); one.k = OP_INT; one.i = 1;
        Operand nx = temp_op();
        Instr *add = emit(I_BIN);
        add->bop = "+"; add->ty = TY_INT; add->rty = TY_INT;
        add->dst = nx; add->a = var_op(s->sym); add->b = one;
        Instr *st = emit(I_COPY);
        st->dst = var_op(s->sym); st->a = nx; st->ty = TY_INT;

        Instr *g = emit(I_GOTO);
        g->label = ltop;
        emit_label(lend);
        break;
    }

    case N_FUNC:
        /* generated as its own unit by tac_generate */
        break;

    default:
        break;
    }
}

static Unit *new_unit(const char *name, Symbol *fsym)
{
    Unit *u = calloc(1, sizeof *u);
    u->name = strdup(name);
    u->fsym = fsym;
    if (units_tail) units_tail->next = u;
    else units_head = u;
    units_tail = u;
    return u;
}

Unit *tac_generate(Node *program)
{
    units_head = units_tail = NULL;
    next_label = 0;

    cur = new_unit("main", NULL);
    for (Node *s = program->body; s; s = s->next) {
        if (s->kind == N_FUNC) continue;
        gen_stmt(s);
    }

    for (Node *s = program->body; s; s = s->next) {
        if (s->kind != N_FUNC || !s->sym) continue;
        Unit *saved = cur;
        cur = new_unit(s->name, s->sym);
        gen_block(s->body);
        /* A void function that falls off the end returns implicitly */
        if (s->sym->type == TY_VOID) emit(I_RETV);
        cur = saved;
    }
    return units_head;
}

int tac_count(const Unit *u)
{
    int n = 0;
    for (const Instr *i = u->first; i; i = i->next)
        if (!i->dead && i->op != I_LABEL) n++;
    return n;
}

/* ---------- Printing ---------- */

char *tac_operand_text(const Operand *o)
{
    char buf[256];
    switch (o->k) {
    case OP_VAR:   snprintf(buf, sizeof buf, "%s", o->sym->name); break;
    case OP_TEMP:  snprintf(buf, sizeof buf, "t%d", o->temp); break;
    case OP_INT:   snprintf(buf, sizeof buf, "%lld", o->i); break;
    case OP_FLOAT: snprintf(buf, sizeof buf, "%g", o->f); break;
    case OP_BOOL:  snprintf(buf, sizeof buf, "%s", o->i ? "true" : "false"); break;
    case OP_STR:   snprintf(buf, sizeof buf, "\"%s\"", strings[o->str]); break;
    default:       snprintf(buf, sizeof buf, "_"); break;
    }
    return strdup(buf);
}

char *tac_instr_text(const Instr *i)
{
    char *d = tac_operand_text(&i->dst), *a = tac_operand_text(&i->a), *b = tac_operand_text(&i->b);
    char buf[512];
    switch (i->op) {
    case I_COPY:    snprintf(buf, sizeof buf, "%s = %s", d, a); break;
    case I_BIN:     snprintf(buf, sizeof buf, "%s = %s %s %s", d, a, i->bop, b); break;
    case I_UN:      snprintf(buf, sizeof buf, "%s = %s %s", d, i->bop, a); break;
    case I_ITOF:    snprintf(buf, sizeof buf, "%s = float(%s)", d, a); break;
    case I_LABEL:   snprintf(buf, sizeof buf, "L%d:", i->label); break;
    case I_GOTO:    snprintf(buf, sizeof buf, "goto L%d", i->label); break;
    case I_IFFALSE: snprintf(buf, sizeof buf, "ifFalse %s goto L%d", a, i->label); break;
    case I_PARAM:   snprintf(buf, sizeof buf, "param %s", a); break;
    case I_CALL:
        if (i->dst.k != OP_NONE) snprintf(buf, sizeof buf, "%s = call %s, %d", d, i->fname, i->nargs);
        else                     snprintf(buf, sizeof buf, "call %s, %d", i->fname, i->nargs);
        break;
    case I_RET:     snprintf(buf, sizeof buf, "return %s", a); break;
    case I_RETV:    snprintf(buf, sizeof buf, "return"); break;
    case I_SHOW:    snprintf(buf, sizeof buf, "show %s", a); break;
    case I_READ:    snprintf(buf, sizeof buf, "%s = read %s", d, type_name(i->ty)); break;
    default:        buf[0] = '\0'; break;
    }
    free(d); free(a); free(b);
    return strdup(buf);
}

static void print_instr(FILE *out, const Instr *i)
{
    char *t = tac_instr_text(i);
    fputs(t, out);
    free(t);
}

void tac_print_unit(FILE *out, const Unit *u)
{
    fprintf(out, "%s:\n", u->fsym ? u->name : "main");
    int any = 0;
    for (const Instr *i = u->first; i; i = i->next) {
        if (i->dead) continue;
        any = 1;
        if (i->op == I_LABEL) { print_instr(out, i); fputc('\n', out); continue; }
        fputs("    ", out);
        print_instr(out, i);
        fputc('\n', out);
    }
    if (!any) fprintf(out, "    (no instructions)\n");
}
