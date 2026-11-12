#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include "common.h"

void fatal(const char *phase, int line, int col, const char *fmt, ...)
{
    va_list ap;
    fprintf(stderr, "[%s error] line %d, col %d: ", phase, line, col);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    exit(1);
}
