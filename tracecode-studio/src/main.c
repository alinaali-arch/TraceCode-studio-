#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ast.h"
#include "codegen.h"
#include "common.h"
#include "semantic.h"
#include "symtab.h"
#include "tac.h"

#ifndef RUNTIME_PATH
#define RUNTIME_PATH "runtime/runtime.asm"
#endif

extern FILE *yyin;          /* defined by Flex */
extern int yyparse(void);
extern int yylex(void);
extern Node *program_root;  /* defined in parser.y */

static const char *USAGE =
    "usage: tracec (--tokens | --ast | --dot | --symbols | --check |\n"
    "               --tac | --opt | --asm | --asm-opt | --phases) <file.tl>\n";

static void usage(void)
{
    fputs(USAGE, stderr);
    exit(2);
}

/* Parse + semantic analysis. Returns the number of semantic errors (-1 on syntax error). */
static int front_end(void)
{
    if (yyparse() != 0) return -1;
    return sem_analyze(program_root);
}

/* Builds TAC for the whole program, optionally optimized, and accumulates the report */
static Unit *build(int optimize, OptReport *total)
{
    Unit *units = tac_generate(program_root);
    memset(total, 0, sizeof *total);
    if (optimize) {
        for (Unit *u = units; u; u = u->next) {
            OptReport r;
            optimize_unit(u, &r);
            total->before += r.before;
            total->after += r.after;
            total->folded += r.folded;
            total->propagated += r.propagated;
            total->simplified += r.simplified;
            total->cse += r.cse;
            total->dead += r.dead;
        }
    } else {
        for (Unit *u = units; u; u = u->next) total->before += tac_count(u);
        total->after = total->before;
    }
    return units;
}

static void print_tac(FILE *out, Unit *units)
{
    for (Unit *u = units; u; u = u->next) {
        tac_print_unit(out, u);
        fputc('\n', out);
    }
}

/* Returns the NASM text in a malloc'd buffer */
static char *asm_text(Unit *units, size_t *len)
{
    char *buf = NULL;
    FILE *m = open_memstream(&buf, len);
    codegen_emit(m, units, RUNTIME_PATH);
    fclose(m);
    return buf;
}

/* Counts real instructions in NASM text (not labels, comments or data) */
static int asm_instr_count(const char *s)
{
    int n = 0;
    for (const char *line = s; *line; ) {
        const char *eol = strchr(line, '\n');
        size_t len = eol ? (size_t)(eol - line) : strlen(line);
        if (len > 4 && strncmp(line, "    ", 4) == 0 && line[4] != ';') {
            /* the runtime and program both indent instructions by four spaces */
            n++;
        }
        if (!eol) break;
        line = eol + 1;
    }
    return n;
}

/* ---------- JSON output for the web interface ---------- */

static void json_str(FILE *o, const char *s)
{
    fputc('"', o);
    for (; s && *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
        case '"':  fputs("\\\"", o); break;
        case '\\': fputs("\\\\", o); break;
        case '\n': fputs("\\n", o);  break;
        case '\t': fputs("\\t", o);  break;
        case '\r': break;
        default:
            if (c < 0x20) fprintf(o, "\\u%04x", c);
            else fputc(c, o);
        }
    }
    fputc('"', o);
}

static void phases_json(void)
{
    /* Plain pipeline: TAC and assembly exactly as generated */
    OptReport none;
    Unit *plain = build(0, &none);
    char *tac_plain = NULL; size_t tp_len = 0;
    FILE *tm = open_memstream(&tac_plain, &tp_len);
    print_tac(tm, plain);
    fclose(tm);
    size_t asm_plain_len = 0;
    char *asm_plain = asm_text(plain, &asm_plain_len);

    /* Optimized pipeline: TAC is regenerated from the same checked AST */
    OptReport rep;
    Unit *opt = build(1, &rep);
    char *tac_opt = NULL; size_t to_len = 0;
    FILE *om = open_memstream(&tac_opt, &to_len);
    print_tac(om, opt);
    fclose(om);
    size_t asm_opt_len = 0;
    char *asm_opt = asm_text(opt, &asm_opt_len);

    printf("{\n  \"tac\": "); json_str(stdout, tac_plain);
    printf(",\n  \"tac_opt\": "); json_str(stdout, tac_opt);
    printf(",\n  \"report\": {\"before\": %d, \"after\": %d, \"folded\": %d, \"propagated\": %d, "
           "\"simplified\": %d, \"cse\": %d, \"dead\": %d},\n",
           rep.before, rep.after, rep.folded, rep.propagated, rep.simplified, rep.cse, rep.dead);
    printf("  \"asm\": "); json_str(stdout, asm_plain);
    printf(",\n  \"asm_opt\": "); json_str(stdout, asm_opt);
    printf(",\n  \"asm_instr\": {\"plain\": %d, \"opt\": %d}\n}\n",
           asm_instr_count(asm_plain), asm_instr_count(asm_opt));

    free(tac_plain); free(tac_opt); free(asm_plain); free(asm_opt);
}

int main(int argc, char **argv)
{
    if (argc != 3) usage();

    const char *mode = argv[1];
    const char *known[] = { "--tokens", "--ast", "--dot", "--symbols", "--symbols-tsv", "--check",
                            "--tac", "--opt", "--asm", "--asm-opt", "--phases", NULL };
    int ok = 0;
    for (int k = 0; known[k]; k++) if (strcmp(mode, known[k]) == 0) ok = 1;
    if (!ok) usage();

    yyin = fopen(argv[2], "r");
    if (!yyin) {
        perror(argv[2]);
        return 1;
    }

    if (strcmp(mode, "--tokens") == 0) {
        printf("  LINE:COL  TOKEN\n");
        while (yylex() != 0)
            printf("%4d:%-3d  %s\n", last_tok_line, last_tok_col, last_tok_txt);
        printf("%4d:%-3d  <EOF>\n", last_tok_line, last_tok_col);
        return 0;
    }

    /* Syntax errors stop here (fatal). Semantic errors are reported and analysis continues. */
    int nerr = front_end();
    if (nerr < 0) return 1;

    if (strcmp(mode, "--ast") == 0) {
        ast_print_text(stdout, program_root, 0);
    } else if (strcmp(mode, "--dot") == 0) {
        ast_print_dot(stdout, program_root);
    } else if (strcmp(mode, "--symbols") == 0) {
        symtab_dump(stdout, 0);
    } else if (strcmp(mode, "--symbols-tsv") == 0) {
        symtab_dump(stdout, 1);
    } else if (strcmp(mode, "--check") == 0) {
        if (nerr == 0) printf("Semantic analysis passed: no errors.\n");
    } else if (nerr > 0) {
        /* code generation needs a program with no semantic errors */
        return 1;
    } else if (strcmp(mode, "--phases") == 0) {
        phases_json();
    } else {
        OptReport rep;
        int optimized = strcmp(mode, "--opt") == 0 || strcmp(mode, "--asm-opt") == 0;
        Unit *units = build(optimized, &rep);
        if (strcmp(mode, "--tac") == 0) {
            print_tac(stdout, units);
        } else if (strcmp(mode, "--opt") == 0) {
            print_tac(stdout, units);
            printf("; optimization report: %d -> %d instructions, folded %d, propagated %d, "
                   "simplified %d, cse %d, dead %d\n",
                   rep.before, rep.after, rep.folded, rep.propagated, rep.simplified, rep.cse, rep.dead);
        } else {
            if (codegen_emit(stdout, units, RUNTIME_PATH) != 0) return 1;
        }
    }

    return nerr ? 1 : 0;
}
