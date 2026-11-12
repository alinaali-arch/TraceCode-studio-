#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "codegen.h"
#include "symtab.h"
#include "tac.h"

/*
 * x86-64 NASM code generation from TAC.
 *
 * Storage:
 *   globals  -> .bss labels g_<name>            accessed as [rel g_<name>]
 *   locals   -> [rbp-8], [rbp-16], ...          (assigned by the symbol table)
 *   params   -> [rbp+16], [rbp+24], ...         (pushed by the caller)
 *   temps    -> [rbp-...] after the locals      (one 8-byte slot per temp)
 * Every TAC value lives in memory; RAX and RBX are scratch registers.
 */

static FILE *o;
static int frame_base;                /* bytes of locals in the current unit */
static char ret_label[160];           /* epilogue label of the current function */

static void ins(const char *fmt, ...)
{
    va_list ap;
    fputs("    ", o);
    va_start(ap, fmt);
    vfprintf(o, fmt, ap);
    va_end(ap);
    fputc('\n', o);
}

/* Memory operand for a variable or temp */
static void mem_of(const Operand *x, char *buf, size_t sz)
{
    if (x->k == OP_TEMP)
        snprintf(buf, sz, "[rbp-%d]", frame_base + 8 * (x->temp + 1));
    else if (x->sym->is_global)
        snprintf(buf, sz, "[rel %s]", x->sym->label);
    else
        snprintf(buf, sz, "[rbp%+d]", x->sym->offset);
}

static void load(const Operand *x, const char *reg)
{
    char m[96];
    switch (x->k) {
    case OP_INT:
    case OP_BOOL:
        ins("mov %s, %lld", reg, x->i);
        break;
    case OP_FLOAT: {
        uint64_t bits;
        memcpy(&bits, &x->f, sizeof bits);
        ins("mov %s, 0x%llx", reg, (unsigned long long)bits);
        break;
    }
    case OP_STR:
        ins("lea %s, [rel str_%d]", reg, x->str);
        break;
    case OP_VAR:
    case OP_TEMP:
        mem_of(x, m, sizeof m);
        ins("mov %s, %s", reg, m);
        break;
    default:
        ins("xor %s, %s", reg, reg);
        break;
    }
}

static void store(const Operand *x, const char *reg)
{
    char m[96];
    if (x->k != OP_VAR && x->k != OP_TEMP) return;
    mem_of(x, m, sizeof m);
    ins("mov %s, %s", m, reg);
}

static const char *int_setcc(const char *op)
{
    if (strcmp(op, "==") == 0) return "sete";
    if (strcmp(op, "!=") == 0) return "setne";
    if (strcmp(op, "<") == 0)  return "setl";
    if (strcmp(op, ">") == 0)  return "setg";
    if (strcmp(op, "<=") == 0) return "setle";
    return "setge";
}

static void gen_bin(const Instr *i)
{
    const char *op = i->bop;
    int arith = strcmp(op, "+") == 0 || strcmp(op, "-") == 0 || strcmp(op, "*") == 0 ||
                strcmp(op, "/") == 0 || strcmp(op, "%") == 0;

    if (i->ty == TY_STRING) {                       /* only == and != are defined */
        load(&i->a, "rdi");
        load(&i->b, "rsi");
        ins("call rt_streq");
        if (strcmp(op, "!=") == 0) ins("xor rax, 1");
        store(&i->dst, "rax");
        return;
    }

    if (i->ty == TY_FLOAT) {
        load(&i->a, "rax");
        load(&i->b, "rbx");
        ins("movq xmm0, rax");
        ins("movq xmm1, rbx");
        if (strcmp(op, "+") == 0)      { ins("addsd xmm0, xmm1"); ins("movq rax, xmm0"); }
        else if (strcmp(op, "-") == 0) { ins("subsd xmm0, xmm1"); ins("movq rax, xmm0"); }
        else if (strcmp(op, "*") == 0) { ins("mulsd xmm0, xmm1"); ins("movq rax, xmm0"); }
        else if (strcmp(op, "/") == 0) { ins("divsd xmm0, xmm1"); ins("movq rax, xmm0"); }
        else if (strcmp(op, "==") == 0) {
            ins("ucomisd xmm0, xmm1");
            ins("sete al");
            ins("setnp cl");
            ins("and al, cl");
            ins("movzx rax, al");
        } else if (strcmp(op, "!=") == 0) {
            ins("ucomisd xmm0, xmm1");
            ins("setne al");
            ins("setp cl");
            ins("or al, cl");
            ins("movzx rax, al");
        } else if (strcmp(op, "<") == 0) {          /* a < b  <=>  b > a */
            ins("ucomisd xmm1, xmm0"); ins("seta al"); ins("movzx rax, al");
        } else if (strcmp(op, "<=") == 0) {
            ins("ucomisd xmm1, xmm0"); ins("setae al"); ins("movzx rax, al");
        } else if (strcmp(op, ">") == 0) {
            ins("ucomisd xmm0, xmm1"); ins("seta al"); ins("movzx rax, al");
        } else {                                    /* >= */
            ins("ucomisd xmm0, xmm1"); ins("setae al"); ins("movzx rax, al");
        }
        store(&i->dst, "rax");
        return;
    }

    /* int and bool */
    load(&i->a, "rax");
    load(&i->b, "rbx");
    if (arith) {
        if (strcmp(op, "+") == 0)      ins("add rax, rbx");
        else if (strcmp(op, "-") == 0) ins("sub rax, rbx");
        else if (strcmp(op, "*") == 0) ins("imul rax, rbx");
        else {                                       /* / or % */
            ins("test rbx, rbx");
            ins("jz rt_fail_divzero");
            ins("cqo");
            ins("idiv rbx");
            if (strcmp(op, "%") == 0) ins("mov rax, rdx");
        }
    } else {
        ins("cmp rax, rbx");
        ins("%s al", int_setcc(op));
        ins("movzx rax, al");
    }
    store(&i->dst, "rax");
}

static void gen_instr(const Instr *i)
{
    char *txt = tac_instr_text(i);
    if (i->op != I_LABEL) fprintf(o, "    ; %s\n", txt);
    free(txt);

    switch (i->op) {
    case I_COPY:
        load(&i->a, "rax");
        store(&i->dst, "rax");
        break;

    case I_BIN:
        gen_bin(i);
        break;

    case I_UN:
        load(&i->a, "rax");
        if (strcmp(i->bop, "not") == 0) {
            ins("xor rax, 1");
        } else if (i->rty == TY_FLOAT) {
            ins("mov rbx, 0x8000000000000000");     /* flip the sign bit */
            ins("xor rax, rbx");
        } else {
            ins("neg rax");
        }
        store(&i->dst, "rax");
        break;

    case I_ITOF:
        load(&i->a, "rax");
        ins("cvtsi2sd xmm0, rax");
        ins("movq rax, xmm0");
        store(&i->dst, "rax");
        break;

    case I_LABEL:
        fprintf(o, ".L%d:\n", i->label);
        break;

    case I_GOTO:
        ins("jmp .L%d", i->label);
        break;

    case I_IFFALSE:
        load(&i->a, "rax");
        ins("test rax, rax");
        ins("jz .L%d", i->label);
        break;

    case I_PARAM:
        load(&i->a, "rax");
        ins("push rax");
        break;

    case I_CALL:
        ins("call fn_%s", i->fname);
        if (i->nargs) ins("add rsp, %d", 8 * i->nargs);
        if (i->dst.k != OP_NONE) store(&i->dst, "rax");
        break;

    case I_RET:
        load(&i->a, "rax");
        ins("jmp %s", ret_label);
        break;

    case I_RETV:
        ins("jmp %s", ret_label);
        break;

    case I_SHOW:
        switch (i->ty) {
        case TY_INT:
            load(&i->a, "rdi");
            ins("call rt_print_int");
            break;
        case TY_BOOL:
            load(&i->a, "rdi");
            ins("call rt_print_bool");
            break;
        case TY_STRING:
            load(&i->a, "rdi");
            ins("call rt_print_str");
            break;
        default: /* float */
            load(&i->a, "rax");
            ins("movq xmm0, rax");
            ins("call rt_print_float");
            break;
        }
        ins("call rt_newline");
        break;

    case I_READ:
        ins(i->ty == TY_STRING ? "call rt_read_str" :
            i->ty == TY_FLOAT  ? "call rt_read_float" :
            i->ty == TY_BOOL   ? "call rt_read_bool" : "call rt_read_int");
        store(&i->dst, "rax");
        break;
    }
}

static void gen_unit(const Unit *u)
{
    frame_base = u->fsym ? u->fsym->frame_bytes : 0;
    int frame = frame_base + 8 * u->ntemps;
    frame = (frame + 15) & ~15;

    if (u->fsym) {
        fprintf(o, "\n; ---- function %s ----\n", u->name);
        fprintf(o, "fn_%s:\n", u->name);
        snprintf(ret_label, sizeof ret_label, ".ret_%s", u->name);
    } else {
        fprintf(o, "\n; ---- main program ----\n");
        fprintf(o, "_start:\n");
        ret_label[0] = '\0';
    }
    ins("push rbp");
    ins("mov rbp, rsp");
    if (frame) ins("sub rsp, %d", frame);

    for (const Instr *i = u->first; i; i = i->next)
        if (!i->dead) gen_instr(i);

    if (u->fsym) {
        fprintf(o, "%s:\n", ret_label);
        ins("mov rsp, rbp");
        ins("pop rbp");
        ins("ret");
    } else {
        ins("mov rdi, 0");                  /* exit(0) */
        ins("mov eax, 60");
        ins("syscall");
    }
}

static void emit_data(void)
{
    fprintf(o, "section .data\n");
    for (int i = 0; i < tac_string_count(); i++) {
        const char *s = tac_string(i);
        fprintf(o, "str_%d: db ", i);               /* bytes, so no escaping problems */
        if (!*s) fprintf(o, "0");
        for (const char *p = s; *p; p++) fprintf(o, "%d,", (unsigned char)*p);
        fprintf(o, "0\n");
    }
    fprintf(o, "\nsection .bss\n");
    for (int i = 0; i < symtab_count(); i++) {
        const Symbol *s = symtab_get(i);
        if (s->kind != SYM_FUNC && s->is_global)
            fprintf(o, "%-14s resq 1          ; %s : %s\n", s->label, s->name, type_name(s->type));
    }
}

static int copy_file(FILE *dst, const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) fwrite(buf, 1, n, dst);
    fclose(f);
    return 0;
}

int codegen_emit(FILE *out, Unit *units, const char *runtime_path)
{
    o = out;
    fprintf(o, "; ==========================================================\n");
    fprintf(o, "; Generated by TraceCode Studio (TraceLang -> x86-64 NASM)\n");
    fprintf(o, "; Build:  nasm -f elf64 program.asm -o program.o\n");
    fprintf(o, ";         ld program.o -o program\n");
    fprintf(o, "; ==========================================================\n");
    fprintf(o, "bits 64\ndefault rel\n\n");

    emit_data();

    fprintf(o, "\nsection .text\nglobal _start\n");
    for (const Unit *u = units; u; u = u->next)
        if (!u->fsym) gen_unit(u);
    for (const Unit *u = units; u; u = u->next)
        if (u->fsym) gen_unit(u);

    fprintf(o, "\n; ---- runtime library (runtime/runtime.asm) ----\n");
    if (copy_file(o, runtime_path) != 0) {
        fprintf(stderr, "[Internal error] line 0, col 0: cannot read runtime file %s\n", runtime_path);
        return -1;
    }
    return 0;
}
