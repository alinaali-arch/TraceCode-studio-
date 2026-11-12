#ifndef SEMANTIC_H
#define SEMANTIC_H

#include "ast.h"

/* Walks the AST, fills in node types and symbol links, builds the symbol table,
 * and reports every semantic and type error (it does not stop at the first one).
 * Returns the number of errors found. */
int sem_analyze(Node *program);

#endif
