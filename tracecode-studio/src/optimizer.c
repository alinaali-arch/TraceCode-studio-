#include <stdlib.h>
#include <string.h>
#include "tac.h"

/*
 * Optimization passes over one TAC unit.
 *
 *  1. Constant propagation  - a variable or temp known to hold a constant is replaced by it
 *  2. Constant folding      - operations on constants are computed at compile time
 *  3. Algebraic simplification - x+0, x*1, x*0, x-x, ...
 *  4. Common subexpression elimination - a repeated a op b inside a block reuses the first result
 *  5. Dead code elimination - unreachable code, unused temps, constant conditions
 *
 * Local passes (1-4) reset their knowledge at every label, because a label can be
 * reached from several places (loops, if-else joins). This keeps them sound.
 */

typedef struct { Operand key, val; } ConstEntry;
typedef struct { const char *bop; Type ty; Operand a, b, res; } AvailEntry;

static ConstEntry *consts;  static int nconst, capconst;
static AvailEntry *avail;   static int navail, capavail;

static int same(Operand x, Operand y)
{
    if (x.k != y.k) return 0;
    switch (x.k) {
    case OP_VAR:   return x.sym == y.sym;
    case OP_TEMP:  return x.temp == y.temp;
    case OP_INT:   case OP_BOOL: return x.i == y.i;
    case OP_FLOAT: return x.f == y.f;
    case OP_STR:   return x.str == y.str;
    default:       return 1;
    }
}

static int is_const(Operand o)
{
    return o.k == OP_INT || o.k == OP_BOOL || o.k == OP_FLOAT || o.k == OP_STR;
}

static int is_storage(Operand o) { return o.k == OP_VAR || o.k == OP_TEMP; }

static void const_set(Operand key, Operand val)
{
    for (int i = 0; i < nconst; i++)
        if (same(consts[i].key, key)) { consts[i].val = val; return; }
    if (nconst == capconst) {
        capconst = capconst ? capconst * 2 : 32;
        consts = realloc(consts, capconst * sizeof *consts);
    }
    consts[nconst].key = key;
    consts[nconst].val = val;
    nconst++;
}

static void const_drop(Operand key)
{
    for (int i = 0; i < nconst; i++)
        if (same(consts[i].key, key)) {
            consts[i] = consts[--nconst];
            return;
        }
}

static int const_get(Operand key, Operand *out)
{
    for (int i = 0; i < nconst; i++)
        if (same(consts[i].key, key)) { *out = consts[i].val; return 1; }
    return 0;
}

/* Forget everything that depends on storage written by 'dst' */
static void invalidate(Operand dst)
{
    if (!is_storage(dst)) return;
    const_drop(dst);
    for (int i = 0; i < navail; i++) {
        AvailEntry *e = &avail[i];
        if (same(e->a, dst) || same(e->b, dst) || same(e->res, dst)) {
            avail[i] = avail[--navail];
            i--;
        }
    }
}

static void invalidate_all_vars(void)
{
    int w = 0;
    for (int i = 0; i < nconst; i++)
        if (consts[i].key.k != OP_VAR) consts[w++] = consts[i];
    nconst = w;
    navail = 0;
}

static Operand mk_int(long long v)  { Operand o = {.k = OP_INT, .i = v}; return o; }
static Operand mk_bool(long long v) { Operand o = {.k = OP_BOOL, .i = v}; return o; }
static Operand mk_float(double v)   { Operand o = {.k = OP_FLOAT, .f = v}; return o; }

/* Turns instruction i into "dst = value" */
static void become_copy(Instr *i, Operand v, Type ty)
{
    i->op = I_COPY;
    i->a = v;
    i->b = (Operand){.k = OP_NONE};
    i->ty = ty;
}

/* Tries to compute a binary operation on two constants */
static int fold_bin(Instr *i, Operand a, Operand b, Operand *out)
{
    const char *op = i->bop;
    if (i->ty == TY_INT && a.k == OP_INT && b.k == OP_INT) {
        long long x = a.i, y = b.i;
        if (strcmp(op, "+") == 0) { *out = mk_int(x + y); return 1; }
        if (strcmp(op, "-") == 0) { *out = mk_int(x - y); return 1; }
        if (strcmp(op, "*") == 0) { *out = mk_int(x * y); return 1; }
        if (strcmp(op, "/") == 0 && y != 0) { *out = mk_int(x / y); return 1; }
        if (strcmp(op, "%") == 0 && y != 0) { *out = mk_int(x % y); return 1; }
        if (strcmp(op, "==") == 0) { *out = mk_bool(x == y); return 1; }
        if (strcmp(op, "!=") == 0) { *out = mk_bool(x != y); return 1; }
        if (strcmp(op, "<") == 0)  { *out = mk_bool(x < y); return 1; }
        if (strcmp(op, ">") == 0)  { *out = mk_bool(x > y); return 1; }
        if (strcmp(op, "<=") == 0) { *out = mk_bool(x <= y); return 1; }
        if (strcmp(op, ">=") == 0) { *out = mk_bool(x >= y); return 1; }
    }
    if (i->ty == TY_FLOAT && a.k == OP_FLOAT && b.k == OP_FLOAT) {
        double x = a.f, y = b.f;
        if (strcmp(op, "+") == 0) { *out = mk_float(x + y); return 1; }
        if (strcmp(op, "-") == 0) { *out = mk_float(x - y); return 1; }
        if (strcmp(op, "*") == 0) { *out = mk_float(x * y); return 1; }
        if (strcmp(op, "/") == 0 && y != 0.0) { *out = mk_float(x / y); return 1; }
        if (strcmp(op, "==") == 0) { *out = mk_bool(x == y); return 1; }
        if (strcmp(op, "!=") == 0) { *out = mk_bool(x != y); return 1; }
        if (strcmp(op, "<") == 0)  { *out = mk_bool(x < y); return 1; }
        if (strcmp(op, ">") == 0)  { *out = mk_bool(x > y); return 1; }
        if (strcmp(op, "<=") == 0) { *out = mk_bool(x <= y); return 1; }
        if (strcmp(op, ">=") == 0) { *out = mk_bool(x >= y); return 1; }
    }
    if (i->ty == TY_BOOL && a.k == OP_BOOL && b.k == OP_BOOL) {
        if (strcmp(op, "==") == 0) { *out = mk_bool(a.i == b.i); return 1; }
        if (strcmp(op, "!=") == 0) { *out = mk_bool(a.i != b.i); return 1; }
    }
    if (i->ty == TY_STRING && a.k == OP_STR && b.k == OP_STR) {
        extern const char *tac_string(int id);
        int eq = strcmp(tac_string(a.str), tac_string(b.str)) == 0;
        if (strcmp(op, "==") == 0) { *out = mk_bool(eq); return 1; }
        if (strcmp(op, "!=") == 0) { *out = mk_bool(!eq); return 1; }
    }
    return 0;
}

static int is_int_zero(Operand o) { return o.k == OP_INT && o.i == 0; }
static int is_int_one(Operand o)  { return o.k == OP_INT && o.i == 1; }

/* Returns 1 if the instruction was rewritten as a simpler one */
static int simplify(Instr *i)
{
    if (i->op != I_BIN || i->ty != TY_INT) return 0;
    const char *op = i->bop;
    Operand a = i->a, b = i->b;
    if (strcmp(op, "+") == 0) {
        if (is_int_zero(b)) { become_copy(i, a, i->ty); return 1; }
        if (is_int_zero(a)) { become_copy(i, b, i->ty); return 1; }
    } else if (strcmp(op, "-") == 0) {
        if (is_int_zero(b)) { become_copy(i, a, i->ty); return 1; }
        if (is_storage(a) && same(a, b)) { become_copy(i, mk_int(0), i->ty); return 1; }
    } else if (strcmp(op, "*") == 0) {
        if (is_int_one(b))  { become_copy(i, a, i->ty); return 1; }
        if (is_int_one(a))  { become_copy(i, b, i->ty); return 1; }
        if (is_int_zero(a) || is_int_zero(b)) { become_copy(i, mk_int(0), i->ty); return 1; }
    } else if (strcmp(op, "/") == 0) {
        if (is_int_one(b))  { become_copy(i, a, i->ty); return 1; }
    }
    return 0;
}

/* One forward pass over the unit. Returns the number of changes made. */
static void forward_pass(Unit *u, OptReport *r, int *changed)
{
    nconst = navail = 0;
    for (Instr *i = u->first; i; i = i->next) {
        if (i->dead) continue;

        if (i->op == I_LABEL) { nconst = navail = 0; continue; }

        /* 1. propagate known constants into the operands */
        Operand *ops[2] = { &i->a, &i->b };
        int nops = 0;
        switch (i->op) {
        case I_BIN:                                        nops = 2; break;
        case I_COPY: case I_UN: case I_ITOF: case I_IFFALSE:
        case I_PARAM: case I_RET: case I_SHOW:             nops = 1; break;
        default:                                           nops = 0; break;
        }
        for (int k = 0; k < nops; k++) {
            Operand v;
            if (is_storage(*ops[k]) && const_get(*ops[k], &v)) {
                *ops[k] = v;
                r->propagated++;
                *changed = 1;
            }
        }

        /* 2. constant folding */
        if (i->op == I_BIN && is_const(i->a) && is_const(i->b)) {
            Operand v;
            if (fold_bin(i, i->a, i->b, &v)) {
                become_copy(i, v, i->rty);
                r->folded++;
                *changed = 1;
            }
        } else if (i->op == I_UN && is_const(i->a)) {
            Operand v;
            if (strcmp(i->bop, "not") == 0 && i->a.k == OP_BOOL) { v = mk_bool(!i->a.i); }
            else if (strcmp(i->bop, "-") == 0 && i->a.k == OP_INT) { v = mk_int(-i->a.i); }
            else if (strcmp(i->bop, "-") == 0 && i->a.k == OP_FLOAT) { v = mk_float(-i->a.f); }
            else goto no_fold_un;
            become_copy(i, v, i->rty);
            r->folded++;
            *changed = 1;
        no_fold_un:;
        } else if (i->op == I_ITOF && i->a.k == OP_INT) {
            become_copy(i, mk_float((double)i->a.i), TY_FLOAT);
            r->folded++;
            *changed = 1;
        }

        /* 3. algebraic simplification */
        if (simplify(i)) { r->simplified++; *changed = 1; }

        /* 4. common subexpression elimination within the block */
        if (i->op == I_BIN && i->dst.k == OP_TEMP) {
            int hit = -1;
            for (int k = 0; k < navail; k++)
                if (strcmp(avail[k].bop, i->bop) == 0 && avail[k].ty == i->ty &&
                    same(avail[k].a, i->a) && same(avail[k].b, i->b)) { hit = k; break; }
            if (hit >= 0) {
                Operand res = avail[hit].res;
                invalidate(i->dst);
                become_copy(i, res, i->rty);
                r->cse++;
                *changed = 1;
            }
        }

        /* 5. record what this instruction defines */
        switch (i->op) {
        case I_COPY:
            invalidate(i->dst);
            if (is_const(i->a) && is_storage(i->dst)) const_set(i->dst, i->a);
            else if (is_storage(i->a) && is_storage(i->dst)) {
                Operand v;
                if (const_get(i->a, &v)) const_set(i->dst, v);
            }
            break;
        case I_BIN:
        case I_UN:
        case I_ITOF:
            invalidate(i->dst);
            if (i->op == I_BIN && i->dst.k == OP_TEMP) {
                if (navail == capavail) {
                    capavail = capavail ? capavail * 2 : 32;
                    avail = realloc(avail, capavail * sizeof *avail);
                }
                avail[navail].bop = i->bop;
                avail[navail].ty = i->ty;
                avail[navail].a = i->a;
                avail[navail].b = i->b;
                avail[navail].res = i->dst;
                navail++;
            }
            break;
        case I_READ:
            invalidate(i->dst);
            break;
        case I_CALL:
            invalidate(i->dst);
            invalidate_all_vars();          /* a call may touch global state */
            break;
        default:
            break;
        }
    }
}

/* Dead code: unreachable instructions, constant branches, unused temps */
static void dead_code(Unit *u, OptReport *r)
{
    /* constant conditions */
    for (Instr *i = u->first; i; i = i->next) {
        if (i->dead || i->op != I_IFFALSE || i->a.k != OP_BOOL) continue;
        if (i->a.i == 0) { i->op = I_GOTO; }           /* always jumps */
        else { i->dead = 1; r->dead++; }               /* never jumps */
    }

    /* unreachable code: after an unconditional transfer, until the next label */
    int unreachable = 0;
    for (Instr *i = u->first; i; i = i->next) {
        if (i->op == I_LABEL) { unreachable = 0; continue; }
        if (unreachable && !i->dead) { i->dead = 1; r->dead++; }
        if (i->op == I_GOTO || i->op == I_RET || i->op == I_RETV) unreachable = 1;
    }

    /* unused temps, removed repeatedly because removing one can make another unused */
    int changed = 1;
    while (changed) {
        changed = 0;
        int *uses = calloc(u->ntemps + 1, sizeof *uses);
        for (Instr *i = u->first; i; i = i->next) {
            if (i->dead) continue;
            if (i->a.k == OP_TEMP) uses[i->a.temp]++;
            if (i->b.k == OP_TEMP) uses[i->b.temp]++;
        }
        for (Instr *i = u->first; i; i = i->next) {
            if (i->dead) continue;
            int pure = i->op == I_COPY || i->op == I_BIN || i->op == I_UN || i->op == I_ITOF;
            if (pure && i->dst.k == OP_TEMP && uses[i->dst.temp] == 0) {
                i->dead = 1;
                r->dead++;
                changed = 1;
            }
        }
        free(uses);
    }
}

void optimize_unit(Unit *u, OptReport *r)
{
    memset(r, 0, sizeof *r);
    r->before = tac_count(u);

    for (int round = 0; round < 6; round++) {
        int changed = 0;
        forward_pass(u, r, &changed);
        if (!changed) break;
    }
    dead_code(u, r);

    free(consts); consts = NULL; nconst = capconst = 0;
    free(avail);  avail = NULL;  navail = capavail = 0;

    r->after = tac_count(u);
}
