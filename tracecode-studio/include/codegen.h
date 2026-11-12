#ifndef CODEGEN_H
#define CODEGEN_H

#include <stdio.h>
#include "tac.h"

/* Writes a complete NASM program (data, bss, text, runtime) for the given units.
 * Returns 0 on success, -1 if the runtime file cannot be read. */
int codegen_emit(FILE *out, Unit *units, const char *runtime_path);

#endif
