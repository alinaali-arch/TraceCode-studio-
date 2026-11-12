%code requires {
#include "ast.h"
}

%{
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common.h"
#include "ast.h"

extern int yylex(void);
void yyerror(const char *msg);

Node *program_root = NULL;

/* Create a node at the location of a grammar symbol: MK(N_X, @1) */
#define MK(k, loc) new_node((k), (loc).first_line, (loc).first_column)

static Node *mkbin(const char *op, Node *l, Node *r)
{
    Node *n = new_node(N_BINOP, l->line, l->col);
    n->name = strdup(op);
    n->e1 = l;
    n->e2 = r;
    return n;
}

static Node *mkun(const char *op, Node *e, int line, int col)
{
    Node *n = new_node(N_UNOP, line, col);
    n->name = strdup(op);
    n->e1 = e;
    return n;
}
%}

%union {
    Node      *node;
    char      *str;
    long long  ival;
    double     fval;
}

%locations
%define parse.error verbose

%token START END SHOW WRITE IF ELIF ELSE WHILE FOR IN TO FUNCTION RETURN
%token AND OR NOT TRUE_KW FALSE_KW
%token T_INT T_FLOAT T_STRING T_BOOL
%token NEWLINE INDENT DEDENT
%token EQ NE LE GE ARROW
%token <str>  IDENT STRING_LIT
%token <ival> INT_LIT
%token <fval> FLOAT_LIT

%type <node> stmt_list stmt suite else_part
%type <node> params_opt params param
%type <node> args_opt args call expr primary
%type <str>  type

/* Precedence: lowest first */
%left  OR
%left  AND
%right NOT
%nonassoc EQ NE '<' '>' LE GE     /* non-associative: a < b < c is an error */
%left  '+' '-'
%left  '*' '/' '%'
%right UMINUS

%start program

%%

program
    : START NEWLINE stmt_list END opt_newline
        { program_root = MK(N_PROGRAM, @1); program_root->body = $3; }
    ;

opt_newline
    : /* empty */
    | NEWLINE
    ;

stmt_list
    : /* empty */             { $$ = NULL; }
    | stmt_list stmt          { $$ = append($1, $2); }
    ;

stmt
    : IDENT ':' type NEWLINE
        { $$ = MK(N_VARDECL, @1); $$->name = $1; $$->type = $3; }
    | IDENT ':' type '=' expr NEWLINE
        { $$ = MK(N_VARDECL, @1); $$->name = $1; $$->type = $3; $$->e1 = $5; }
    | IDENT '=' expr NEWLINE
        { $$ = MK(N_ASSIGN, @1); $$->name = $1; $$->e1 = $3; }
    | WRITE IDENT NEWLINE
        { $$ = MK(N_WRITE, @1); $$->name = $2; }
    | WRITE IDENT ':' type NEWLINE
        { $$ = MK(N_WRITE, @1); $$->name = $2; $$->type = $4; }
    | SHOW expr NEWLINE
        { $$ = MK(N_SHOW, @1); $$->e1 = $2; }
    | IF expr ':' suite else_part
        { $$ = MK(N_IF, @1); $$->e1 = $2; $$->body = $4; $$->orelse = $5; }
    | WHILE expr ':' suite
        { $$ = MK(N_WHILE, @1); $$->e1 = $2; $$->body = $4; }
    | FOR IDENT IN expr TO expr ':' suite
        { $$ = MK(N_FOR, @1); $$->name = $2; $$->e1 = $4; $$->e2 = $6; $$->body = $8; }
    | FUNCTION IDENT '(' params_opt ')' ':' suite
        { $$ = MK(N_FUNC, @1); $$->name = $2; $$->args = $4; $$->body = $7; }
    | FUNCTION IDENT '(' params_opt ')' ARROW type ':' suite
        { $$ = MK(N_FUNC, @1); $$->name = $2; $$->args = $4; $$->type = $7; $$->body = $9; }
    | RETURN NEWLINE
        { $$ = MK(N_RETURN, @1); }
    | RETURN expr NEWLINE
        { $$ = MK(N_RETURN, @1); $$->e1 = $2; }
    | call NEWLINE
        { $$ = MK(N_CALL_STMT, @1); $$->e1 = $1; }
    ;

else_part
    : /* empty */
        { $$ = NULL; }
    | ELIF expr ':' suite else_part
        { $$ = MK(N_IF, @1); $$->e1 = $2; $$->body = $4; $$->orelse = $5; }
    | ELSE ':' suite
        { $$ = $3; }
    ;

suite
    : NEWLINE INDENT stmt_list DEDENT
        { $$ = $3; }
    ;

params_opt
    : /* empty */             { $$ = NULL; }
    | params                  { $$ = $1; }
    ;

params
    : param                   { $$ = $1; }
    | params ',' param        { $$ = append($1, $3); }
    ;

param
    : IDENT ':' type          { $$ = MK(N_PARAM, @1); $$->name = $1; $$->type = $3; }
    ;

type
    : T_INT                   { $$ = strdup("int"); }
    | T_FLOAT                 { $$ = strdup("float"); }
    | T_STRING                { $$ = strdup("string"); }
    | T_BOOL                  { $$ = strdup("bool"); }
    ;

expr
    : expr OR expr            { $$ = mkbin("or", $1, $3); }
    | expr AND expr           { $$ = mkbin("and", $1, $3); }
    | NOT expr                { $$ = mkun("not", $2, @1.first_line, @1.first_column); }
    | expr EQ expr            { $$ = mkbin("==", $1, $3); }
    | expr NE expr            { $$ = mkbin("!=", $1, $3); }
    | expr '<' expr           { $$ = mkbin("<", $1, $3); }
    | expr '>' expr           { $$ = mkbin(">", $1, $3); }
    | expr LE expr            { $$ = mkbin("<=", $1, $3); }
    | expr GE expr            { $$ = mkbin(">=", $1, $3); }
    | expr '+' expr           { $$ = mkbin("+", $1, $3); }
    | expr '-' expr           { $$ = mkbin("-", $1, $3); }
    | expr '*' expr           { $$ = mkbin("*", $1, $3); }
    | expr '/' expr           { $$ = mkbin("/", $1, $3); }
    | expr '%' expr           { $$ = mkbin("%", $1, $3); }
    | '-' expr %prec UMINUS   { $$ = mkun("-", $2, @1.first_line, @1.first_column); }
    | primary                 { $$ = $1; }
    ;

primary
    : INT_LIT                 { $$ = MK(N_INT, @1);    $$->ival = $1; }
    | FLOAT_LIT               { $$ = MK(N_FLOAT, @1);  $$->fval = $1; }
    | STRING_LIT              { $$ = MK(N_STRING, @1); $$->name = $1; }
    | TRUE_KW                 { $$ = MK(N_BOOL, @1);   $$->ival = 1; }
    | FALSE_KW                { $$ = MK(N_BOOL, @1);   $$->ival = 0; }
    | IDENT                   { $$ = MK(N_IDENT, @1);  $$->name = $1; }
    | call                    { $$ = $1; }
    | '(' expr ')'            { $$ = $2; }
    ;

call
    : IDENT '(' args_opt ')'  { $$ = MK(N_CALL, @1); $$->name = $1; $$->args = $3; }
    ;

args_opt
    : /* empty */             { $$ = NULL; }
    | args                    { $$ = $1; }
    ;

args
    : expr                    { $$ = $1; }
    | args ',' expr           { $$ = append($1, $3); }
    ;

%%

/* Report the token that caused the error (set by the lexer wrapper, not yylloc,
 * because INDENT/DEDENT tokens are queued and yylloc may point one token ahead). */
/* Turn Bison's message into a short correction the user can act on */
static const char *syntax_fix(const char *msg)
{
    if (strstr(msg, "unexpected NEWLINE"))
        return "the line is incomplete: finish the expression, or add the missing value after '=' or ':'";
    if (strstr(msg, "unexpected INDENT"))
        return "indent only after a line that ends with ':' (if, while, for, function, else, elif)";
    if (strstr(msg, "unexpected DEDENT"))
        return "check the indentation: each block must be indented the same amount, and 'end' must be at column 1";
    if (strstr(msg, "unexpected end of file"))
        return "add 'end' on its own line at the bottom of the program";
    if (strstr(msg, "unexpected ':'"))
        return "':' only belongs after if, elif, else, while, for or a function header";
    if (strstr(msg, "expecting"))
        return "check the spelling, the brackets and the colons on this line";
    return "check the syntax of this line against the language reference";
}

void yyerror(const char *msg)
{
    char buf[512];
    snprintf(buf, sizeof buf, "%s | Fix: %s", msg, syntax_fix(msg));
    fatal("Syntax", last_tok_line, last_tok_col, "%s", buf);
}
