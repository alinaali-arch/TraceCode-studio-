%{
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common.h"
#include "ast.h"
#include "parser.tab.h"

/* Rename the Flex scanner so yylex() can be a wrapper that handles INDENT/DEDENT */
#define YY_DECL int yylex_raw(void)

/* ---- Source position ---- */
static int cur_line = 1, cur_col = 1;
static int tok_line = 1, tok_col = 1;

#define YY_USER_ACTION                                            \
    tok_line = cur_line; tok_col = cur_col; cur_col += yyleng;    \
    yylloc.first_line = yylloc.last_line = cur_line;              \
    yylloc.first_column = tok_col; yylloc.last_column = cur_col - 1;

/* Exported for parser diagnostics and the --tokens dump */
int last_tok_line = 1, last_tok_col = 1;
const char *last_tok_txt = "";

/* ---- Queue of tokens ready for the parser ---- */
#define MAXQ 1024
static int         qtok[MAXQ];
static const char *qtxt[MAXQ];
static int         qline[MAXQ], qcol[MAXQ];
/* Semantic value and location must travel with each queued token: several tokens
 * may be produced by one scan, so the shared yylval/yylloc would be overwritten. */
static YYSTYPE     qval[MAXQ];
static YYLTYPE     qloc[MAXQ];
static int         qh = 0, qt = 0;

/* ---- Indentation state ---- */
#define MAXDEPTH 256
static int indent_stack[MAXDEPTH];  /* indent_stack[0] is always 0 */
static int depth = 0;
static int fresh_line = 1;          /* true until the first real token of a line */
static int pending_indent = 0;      /* leading spaces of the current line */

static void enqueue(int tok, const char *txt)
{
    if (qt >= MAXQ) fatal("Internal", tok_line, tok_col, "token queue overflow");
    qtok[qt]  = tok;
    qtxt[qt]  = txt;
    qline[qt] = tok_line;
    qcol[qt]  = tok_col;
    qval[qt]  = yylval;
    qloc[qt]  = yylloc;
    qt++;
}

/* Emit a real token. If it is the first token on a line, first emit INDENT/DEDENTs. */
static void emit(int tok, const char *txt)
{
    if (fresh_line) {
        fresh_line = 0;
        if (pending_indent > indent_stack[depth]) {
            if (depth + 1 >= MAXDEPTH) fatal("Lexical", tok_line, 1, "nesting too deep");
            indent_stack[++depth] = pending_indent;
            enqueue(INDENT, "<INDENT>");
        } else {
            while (pending_indent < indent_stack[depth]) {
                depth--;
                enqueue(DEDENT, "<DEDENT>");
            }
            if (pending_indent != indent_stack[depth])
                fatal("Lexical", tok_line, 1,
                      "inconsistent indentation (%d spaces) does not match any outer block",
                      pending_indent);
        }
    }
    enqueue(tok, strdup(txt));
}

#define TOK(t) emit((t), yytext)

/* Convert a string literal including its quotes into its value */
static char *unescape(const char *lit)
{
    size_t n = strlen(lit);
    char *out = malloc(n + 1);
    size_t j = 0;
    for (size_t i = 1; i + 1 < n; i++) {
        if (lit[i] != '\\') {
            out[j++] = lit[i];
            continue;
        }
        i++;
        switch (lit[i]) {
        case 'n':  out[j++] = '\n'; break;
        case 't':  out[j++] = '\t'; break;
        case '"':  out[j++] = '"';  break;
        case '\\': out[j++] = '\\'; break;
        default:
            fatal("Lexical", tok_line, tok_col, "unknown escape sequence '\\%c'", lit[i]);
        }
    }
    out[j] = '\0';
    return out;
}
%}

%option noyywrap nounput noinput

%%

    /* Indentation: spaces at the start of a line set the pending indent width */
^" "+                       { pending_indent = yyleng; }

    /* Other whitespace and comments are ignored */
[ \r]+                      ;
"#"[^\n]*                   ;

\t                          { fatal("Lexical", tok_line, tok_col,
                                    "tab characters are not allowed; indent with spaces"); }

\n                          {
                                cur_line++;
                                cur_col = 1;
                                if (!fresh_line) {
                                    enqueue(NEWLINE, "<NEWLINE>");
                                    fresh_line = 1;
                                }
                                pending_indent = 0;
                            }

    /* Keywords (must come before the identifier rule) */
"start"                     { TOK(START); }
"end"                       { TOK(END); }
"show"                      { TOK(SHOW); }
"write"                     { TOK(WRITE); }
"if"                        { TOK(IF); }
"elif"                      { TOK(ELIF); }
"else"                      { TOK(ELSE); }
"while"                     { TOK(WHILE); }
"for"                       { TOK(FOR); }
"in"                        { TOK(IN); }
"to"                        { TOK(TO); }
"function"                  { TOK(FUNCTION); }
"return"                    { TOK(RETURN); }
"and"                       { TOK(AND); }
"or"                        { TOK(OR); }
"not"                       { TOK(NOT); }
"true"                      { TOK(TRUE_KW); }
"false"                     { TOK(FALSE_KW); }
"int"                       { TOK(T_INT); }
"float"                     { TOK(T_FLOAT); }
"string"                    { TOK(T_STRING); }
"bool"                      { TOK(T_BOOL); }

    /* Literals */
\"([^\\\"\n]|\\.)*\"        { yylval.str = unescape(yytext); emit(STRING_LIT, yytext); }
\"([^\\\"\n]|\\.)*          { fatal("Lexical", tok_line, tok_col, "unterminated string literal"); }
[0-9]+"."[0-9]+             { yylval.fval = strtod(yytext, NULL); TOK(FLOAT_LIT); }
[0-9]+                      { yylval.ival = strtoll(yytext, NULL, 10); TOK(INT_LIT); }
[A-Za-z_][A-Za-z0-9_]*      { yylval.str = strdup(yytext); TOK(IDENT); }

    /* Operators and punctuation */
"=="                        { TOK(EQ); }
"!="                        { TOK(NE); }
"<="                        { TOK(LE); }
">="                        { TOK(GE); }
"->"                        { TOK(ARROW); }
"("|")"|":"|","|"<"|">"|"="|"+"|"-"|"*"|"/"|"%" { TOK(yytext[0]); }

    /* Anything else is an invalid token */
.                           { fatal("Lexical", tok_line, tok_col,
                                    "invalid character '%c'", yytext[0]); }

<<EOF>>                     {
                                if (!fresh_line) {
                                    enqueue(NEWLINE, "<NEWLINE>");
                                    fresh_line = 1;
                                }
                                while (depth > 0) {
                                    depth--;
                                    enqueue(DEDENT, "<DEDENT>");
                                }
                                enqueue(0, "<EOF>");
                                return 0;
                            }

%%

/* Wrapper used by the parser. Runs the scanner until at least one token is queued. */
int yylex(void)
{
    while (qh == qt) {
        qh = qt = 0;
        yylex_raw();
    }
    last_tok_line = qline[qh];
    last_tok_col  = qcol[qh];
    last_tok_txt  = qtxt[qh];
    yylval        = qval[qh];
    yylloc        = qloc[qh];
    return qtok[qh++];
}
