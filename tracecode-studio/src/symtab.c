#include <stdlib.h>
#include <string.h>
#include "symtab.h"
#include "common.h"

typedef struct Scope {
    char *name;
    int depth;
    Symbol *first;          /* symbols declared directly in this scope */
    struct Scope *parent;
} Scope;

static Scope  *cur_scope = NULL;
static Symbol *cur_func = NULL;
static Symbol **all = NULL;     /* every symbol ever declared, in order */
static int nall = 0, capall = 0;

static char *make_label(const char *prefix, const char *name)
{
    size_t n = strlen(prefix) + strlen(name) + 1;
    char *s = malloc(n);
    snprintf(s, n, "%s%s", prefix, name);
    return s;
}

void symtab_reset(void)
{
    cur_scope = NULL;
    cur_func = NULL;
    nall = 0;
    scope_push("global", 0);
}

void scope_push(const char *name, int line)
{
    (void)line;
    Scope *s = calloc(1, sizeof *s);
    s->name = strdup(name);
    s->parent = cur_scope;
    s->depth = cur_scope ? cur_scope->depth + 1 : 0;
    cur_scope = s;
}

void scope_pop(void)
{
    if (!cur_scope || !cur_scope->parent) return;   /* never pop the global scope */
    cur_scope = cur_scope->parent;
}

int scope_depth(void)
{
    return cur_scope ? cur_scope->depth : 0;
}

Symbol *symbol_declare(const char *name, SymKind kind, Type type, int line, int col)
{
    Symbol *s = calloc(1, sizeof *s);
    s->name = strdup(name);
    s->kind = kind;
    s->type = type;
    s->scope = cur_scope->name;
    s->depth = cur_scope->depth;
    s->line = line;
    s->col = col;

    s->is_global = (cur_func == NULL);

    if (kind == SYM_FUNC) {
        s->label = make_label("fn_", name);
        s->initialized = 1;
        s->is_global = 1;
    } else if (s->is_global) {
        /* Globals live in .bss. Variables declared inside top-level blocks get a unique
         * label, so two loops that both use 'k' do not share storage by accident. */
        char suffix[32] = "";
        if (s->depth > 0) snprintf(suffix, sizeof suffix, "_%d", nall);
        size_t n = strlen("g_") + strlen(name) + strlen(suffix) + 1;
        s->label = malloc(n);
        snprintf(s->label, n, "g_%s%s", name, suffix);
    } else if (kind == SYM_VAR) {
        /* Each local gets an 8-byte slot below rbp: [rbp-8], [rbp-16], ... */
        cur_func->frame_bytes += 8;
        s->offset = -cur_func->frame_bytes;
    }
    /* Parameter offsets are assigned by the caller, which knows the argument order */

    s->next_in_scope = cur_scope->first;
    cur_scope->first = s;

    if (nall == capall) {
        capall = capall ? capall * 2 : 32;
        all = realloc(all, capall * sizeof *all);
    }
    all[nall++] = s;
    return s;
}

Symbol *symbol_lookup(const char *name)
{
    for (Scope *sc = cur_scope; sc; sc = sc->parent)
        for (Symbol *s = sc->first; s; s = s->next_in_scope)
            if (strcmp(s->name, name) == 0) return s;
    return NULL;
}

Symbol *symbol_lookup_current(const char *name)
{
    for (Symbol *s = cur_scope->first; s; s = s->next_in_scope)
        if (strcmp(s->name, name) == 0) return s;
    return NULL;
}

void symtab_enter_func(Symbol *f) { cur_func = f; }
void symtab_leave_func(void)      { cur_func = NULL; }
Symbol *symtab_cur_func(void)     { return cur_func; }

int symtab_count(void)        { return nall; }
Symbol *symtab_get(int i)     { return all[i]; }

/* "(int, int) -> int" */
static void signature(const Symbol *f, char *buf, size_t sz)
{
    size_t used = 0;
    used += snprintf(buf + used, sz - used, "(");
    for (int i = 0; i < f->nparams; i++)
        used += snprintf(buf + used, sz - used, "%s%s", i ? ", " : "", type_name(f->ptypes[i]));
    snprintf(buf + used, sz - used, ") -> %s", type_name(f->type));
}

static const char *kind_text(const Symbol *s)
{
    if (s->kind == SYM_FUNC)  return "function";
    if (s->kind == SYM_PARAM) return "parameter";
    if (s->readonly)          return "loop var";
    return "variable";
}

void symtab_dump(FILE *o, int tsv)
{
    if (tsv) fprintf(o, "NAME\tKIND\tTYPE\tSCOPE\tINITIAL VALUE\tSTORAGE\n");
    else {
        fprintf(o, "%-12s %-10s %-22s %-20s %-18s %s\n",
                "NAME", "KIND", "TYPE", "SCOPE", "INITIAL VALUE", "STORAGE");
        fprintf(o, "%s\n", "----------------------------------------------------------------------------------------------");
    }
    for (int i = 0; i < nall; i++) {
        const Symbol *s = all[i];
        char typ[96];
        if (s->kind == SYM_FUNC) signature(s, typ, sizeof typ);
        else snprintf(typ, sizeof typ, "%s", type_name(s->type));

        const char *init;
        if (s->kind == SYM_FUNC)      init = "-";
        else if (s->init_text)        init = s->init_text;
        else if (s->initialized)      init = "(assigned later)";
        else                          init = "uninitialized";

        char storage[96];
        if (s->kind == SYM_FUNC)               snprintf(storage, sizeof storage, "code  %s", s->label);
        else if (s->is_global)                 snprintf(storage, sizeof storage, "data  %s (.bss)", s->label);
        else if (s->kind == SYM_PARAM)         snprintf(storage, sizeof storage, "stack [rbp+%d]", s->offset);
        else                                   snprintf(storage, sizeof storage, "stack [rbp%d]", s->offset);

        if (tsv)
            fprintf(o, "%s\t%s\t%s\t%s\t%s\t%s\n", s->name, kind_text(s), typ, s->scope, init, storage);
        else
            fprintf(o, "%-12s %-10s %-22s %-20s %-18s %s\n",
                    s->name, kind_text(s), typ, s->scope, init, storage);
    }
}
