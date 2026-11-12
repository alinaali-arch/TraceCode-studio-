#include <stdlib.h>
#include <string.h>
#include "ast.h"
#include "common.h"

Node *new_node(NodeKind kind, int line, int col)
{
    Node *n = calloc(1, sizeof *n);
    if (!n) fatal("Internal", line, col, "out of memory");
    n->kind = kind;
    n->line = line;
    n->col = col;
    n->ty = TY_UNKNOWN;
    return n;
}

Node *append(Node *list, Node *n)
{
    if (!n) return list;
    if (!list) return n;
    Node *p = list;
    while (p->next) p = p->next;
    p->next = n;
    return list;
}

const char *type_name(Type t)
{
    switch (t) {
    case TY_INT:     return "int";
    case TY_FLOAT:   return "float";
    case TY_STRING:  return "string";
    case TY_BOOL:    return "bool";
    case TY_VOID:    return "void";
    default:         return "unknown";
    }
}

Type type_from_name(const char *s)
{
    if (!s) return TY_UNKNOWN;
    if (strcmp(s, "int") == 0)    return TY_INT;
    if (strcmp(s, "float") == 0)  return TY_FLOAT;
    if (strcmp(s, "string") == 0) return TY_STRING;
    if (strcmp(s, "bool") == 0)   return TY_BOOL;
    return TY_UNKNOWN;
}

/* Expression nodes show their inferred type after semantic analysis */
static int is_expr(NodeKind k)
{
    return k == N_BINOP || k == N_UNOP || k == N_INT || k == N_FLOAT ||
           k == N_STRING || k == N_BOOL || k == N_IDENT || k == N_CALL;
}

/* One-line human-readable label for a node */
static void make_label(const Node *n, char *b, size_t sz)
{
    switch (n->kind) {
    case N_PROGRAM:   snprintf(b, sz, "Program"); break;
    case N_VARDECL:   snprintf(b, sz, "VarDecl %s : %s", n->name, n->type); break;
    case N_ASSIGN:    snprintf(b, sz, "Assign %s", n->name); break;
    case N_WRITE:
        if (n->type) snprintf(b, sz, "Write %s : %s", n->name, n->type);
        else         snprintf(b, sz, "Write %s", n->name);
        break;
    case N_SHOW:      snprintf(b, sz, "Show"); break;
    case N_IF:        snprintf(b, sz, "If / elif"); break;
    case N_WHILE:     snprintf(b, sz, "While"); break;
    case N_FOR:       snprintf(b, sz, "For %s", n->name); break;
    case N_FUNC:      snprintf(b, sz, "Function %s -> %s", n->name, n->type ? n->type : "void"); break;
    case N_PARAM:     snprintf(b, sz, "Param %s : %s", n->name, n->type); break;
    case N_RETURN:    snprintf(b, sz, "Return"); break;
    case N_CALL_STMT: snprintf(b, sz, "CallStmt"); break;
    case N_BINOP:     snprintf(b, sz, "BinOp %s", n->name); break;
    case N_UNOP:      snprintf(b, sz, "UnOp %s", n->name); break;
    case N_INT:       snprintf(b, sz, "Int %lld", n->ival); break;
    case N_FLOAT:     snprintf(b, sz, "Float %g", n->fval); break;
    case N_STRING:    snprintf(b, sz, "String \"%s\"", n->name); break;
    case N_BOOL:      snprintf(b, sz, "Bool %s", n->ival ? "true" : "false"); break;
    case N_IDENT:     snprintf(b, sz, "Ident %s", n->name); break;
    case N_CALL:      snprintf(b, sz, "Call %s", n->name); break;
    }
}

/* ---------- Text tree ---------- */

static void indent(FILE *o, int d)
{
    for (int i = 0; i < d; i++) fputs("  ", o);
}

static void print_list_block(FILE *o, const char *title, const Node *l, int d)
{
    indent(o, d);
    fprintf(o, "[%s]\n", title);
    for (const Node *p = l; p; p = p->next)
        ast_print_text(o, p, d + 1);
}

void ast_print_text(FILE *o, const Node *n, int d)
{
    char lbl[256];
    make_label(n, lbl, sizeof lbl);
    indent(o, d);
    fprintf(o, "%s", lbl);
    if (is_expr(n->kind) && n->ty != TY_UNKNOWN)
        fprintf(o, " <%s>", type_name(n->ty));
    fprintf(o, "   (line %d, col %d)\n", n->line, n->col);

    if (n->e1) ast_print_text(o, n->e1, d + 1);
    if (n->e2) ast_print_text(o, n->e2, d + 1);
    if (n->args) print_list_block(o, n->kind == N_FUNC ? "params" : "args", n->args, d + 1);
    if (n->body) print_list_block(o, "body", n->body, d + 1);
    if (n->orelse) print_list_block(o, "else", n->orelse, d + 1);
}

/* ---------- Graphviz DOT ---------- */

static int dot_counter;

static void dot_escape(const char *in, char *out, size_t sz)
{
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 2 < sz; i++) {
        if (in[i] == '"' || in[i] == '\\') out[j++] = '\\';
        out[j++] = in[i];
    }
    out[j] = '\0';
}

/* Colour by category so the graph reads at a glance (see the legend in the UI) */
static const char *dot_color(NodeKind k)
{
    switch (k) {
    case N_PROGRAM:                                   return "#e2e8f0";
    case N_VARDECL: case N_WRITE: case N_FUNC:
    case N_PARAM:                                     return "#bfdbfe";
    case N_IF: case N_WHILE: case N_FOR:              return "#fde68a";
    case N_ASSIGN: case N_SHOW: case N_RETURN:
    case N_CALL_STMT:                                 return "#ddd6fe";
    default:                                          return "#bbf7d0";   /* expressions */
    }
}

static int dot_node(FILE *o, const Node *n);

static void dot_list(FILE *o, int pid, const Node *l)
{
    for (const Node *p = l; p; p = p->next) {
        int cid = dot_node(o, p);
        fprintf(o, "  n%d -> n%d;\n", pid, cid);
    }
}

static int dot_node(FILE *o, const Node *n)
{
    char lbl[256], esc[512], full[300];
    int id = ++dot_counter;

    make_label(n, lbl, sizeof lbl);
    if (is_expr(n->kind) && n->ty != TY_UNKNOWN)
        snprintf(full, sizeof full, "%s : %s", lbl, type_name(n->ty));
    else
        snprintf(full, sizeof full, "%s", lbl);
    dot_escape(full, esc, sizeof esc);
    fprintf(o, "  n%d [label=\"%s\\n(line %d)\", fillcolor=\"%s\", style=\"rounded,filled\"];\n",
            id, esc, n->line, dot_color(n->kind));

    if (n->e1) {
        int c = dot_node(o, n->e1);
        fprintf(o, "  n%d -> n%d;\n", id, c);
    }
    if (n->e2) {
        int c = dot_node(o, n->e2);
        fprintf(o, "  n%d -> n%d;\n", id, c);
    }
    dot_list(o, id, n->args);
    dot_list(o, id, n->body);
    dot_list(o, id, n->orelse);
    return id;
}

void ast_print_dot(FILE *o, const Node *root)
{
    dot_counter = 0;
    fprintf(o, "digraph TraceLangAST {\n");
    fprintf(o, "  rankdir=TB;\n");
    fprintf(o, "  node [shape=box, fontname=\"Helvetica\", fontsize=11, color=\"#64748b\"];\n");
    fprintf(o, "  edge [color=\"#94a3b8\"];\n");
    dot_node(o, root);
    fprintf(o, "}\n");
}
