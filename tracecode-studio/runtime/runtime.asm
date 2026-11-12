; ===========================================================================
; TraceLang runtime (x86-64 Linux, NASM). Included verbatim in every program.
; Calling convention used by generated code:
;   arguments are pushed on the stack (left to right), results return in RAX,
;   floats travel as their bit pattern in RAX and are moved to XMM0 when needed.
; All I/O uses Linux system calls directly (no libc).
; ===========================================================================

section .data
rt_true:      db "true"
rt_false:     db "false"
rt_nl_char:    db 10
rt_minus:     db "-"
rt_dot:       db "."
rt_divzero:   db "runtime error: division by zero", 10
rt_divzero_len equ $ - rt_divzero
rt_badint:    db "runtime error: expected an integer input", 10
rt_badint_len equ $ - rt_badint
rt_badfloat: db "runtime error: expected a number input", 10
rt_badfloat_len equ $ - rt_badfloat
rt_badbool:  db "runtime error: expected true or false", 10
rt_badbool_len equ $ - rt_badbool

section .bss
rt_heap:      resb 1048576          ; 1 MB bump-allocated pool for string input
rt_heap_top:  resq 1

section .text

; rt_write(rsi = buffer, rdx = length): writes to standard output
rt_write:
    mov eax, 1
    mov edi, 1
    syscall
    ret

; rt_print_uint(rax = unsigned value): prints decimal digits, no newline
rt_print_uint:
    push rbp
    mov rbp, rsp
    sub rsp, 32
    mov rdi, rbp                  ; write digits backwards from rbp-1
    mov rcx, 10
.digit:
    xor rdx, rdx
    div rcx                       ; rax = quotient, rdx = remainder
    add dl, '0'
    dec rdi
    mov [rdi], dl
    test rax, rax
    jnz .digit
    mov rsi, rdi
    mov rdx, rbp
    sub rdx, rdi                  ; length = rbp - start
    call rt_write
    leave
    ret

; rt_print_int(rdi = signed value)
rt_print_int:
    push rbp
    mov rbp, rsp
    mov rax, rdi
    test rax, rax
    jns .positive
    push rax
    lea rsi, [rel rt_minus]
    mov edx, 1
    call rt_write
    pop rax
    neg rax
.positive:
    call rt_print_uint
    leave
    ret

; rt_print_bool(rdi = 0 or 1)
rt_print_bool:
    push rbp
    mov rbp, rsp
    test rdi, rdi
    jz .false
    lea rsi, [rel rt_true]
    mov edx, 4
    jmp .out
.false:
    lea rsi, [rel rt_false]
    mov edx, 5
.out:
    call rt_write
    leave
    ret

; rt_print_str(rdi = NUL-terminated string)
rt_print_str:
    push rbp
    mov rbp, rsp
    mov rsi, rdi
    xor rdx, rdx
.len:
    cmp byte [rsi + rdx], 0
    je .done
    inc rdx
    jmp .len
.done:
    call rt_write
    leave
    ret

; rt_print_float(xmm0 = value): prints with exactly six decimal digits
rt_print_float:
    push rbp
    mov rbp, rsp
    mov rax, 0x412E848000000000   ; 1000000.0
    movq xmm1, rax
    mulsd xmm0, xmm1
    cvtsd2si rax, xmm0            ; scaled value, rounded to nearest
    test rax, rax
    jns .positive
    push rax
    lea rsi, [rel rt_minus]
    mov edx, 1
    call rt_write
    pop rax
    neg rax
.positive:
    xor rdx, rdx
    mov rcx, 1000000
    div rcx                       ; rax = integer part, rdx = six-digit fraction
    push rdx
    call rt_print_uint
    lea rsi, [rel rt_dot]
    mov edx, 1
    call rt_write
    pop rax
    sub rsp, 8                    ; 8-byte scratch buffer
    mov rcx, 6
.frac:
    xor rdx, rdx
    mov r8, 10
    div r8
    add dl, '0'
    dec rcx
    mov [rsp + rcx], dl
    test rcx, rcx
    jnz .frac
    mov rsi, rsp
    mov edx, 6
    call rt_write
    add rsp, 8
    leave
    ret

; rt_newline: prints a line feed
rt_newline:
    lea rsi, [rel rt_nl_char]
    mov edx, 1
    call rt_write
    ret

; rt_readline(rsi = buffer, rdx = capacity): reads one line from standard input.
; Stores it without the line feed, NUL-terminates it, and returns its length in RAX.
; Lines longer than capacity-1 are truncated.
rt_readline:
    push rbp
    mov rbp, rsp
    push rbx
    push r12
    push r13
    mov r12, rsi
    mov r13, rdx
    xor rbx, rbx
.next:
    lea rsi, [r12 + rbx]
    mov edx, 1
    xor edi, edi                  ; fd 0 = standard input
    xor eax, eax                  ; SYS_read
    syscall
    test rax, rax
    jle .end                      ; end of input or error
    movzx eax, byte [r12 + rbx]
    cmp eax, 10
    je .end
    inc rbx
    lea rax, [r13 - 1]
    cmp rbx, rax
    jb .next
.end:
    test rbx, rbx
    jz .terminate
    cmp byte [r12 + rbx - 1], 13  ; drop a carriage return from Windows line endings
    jne .terminate
    dec rbx
.terminate:
    mov byte [r12 + rbx], 0
    mov rax, rbx
    pop r13
    pop r12
    pop rbx
    leave
    ret

; rt_read_int(): reads a signed decimal integer; anything else is a runtime error
rt_read_int:
    push rbp
    mov rbp, rsp
    sub rsp, 512
    mov rsi, rsp
    mov edx, 512
    call rt_readline
    mov rsi, rsp
    xor rax, rax                  ; accumulated value
    xor rcx, rcx                  ; negative flag
    xor r8, r8                    ; digit count
.skip:
    cmp byte [rsi], ' '
    jne .sign
    inc rsi
    jmp .skip
.sign:
    cmp byte [rsi], '-'
    jne .digits
    mov rcx, 1
    inc rsi
.digits:
    movzx rdx, byte [rsi]
    sub rdx, '0'
    cmp rdx, 9
    ja .done
    imul rax, rax, 10
    add rax, rdx
    inc r8
    inc rsi
    jmp .digits
.done:
    test r8, r8
    jz .bad
    test rcx, rcx
    jz .ok
    neg rax
.ok:
    leave
    ret
.bad:
    lea rsi, [rel rt_badint]
    mov edx, rt_badint_len
    mov edi, 2
    mov eax, 1
    syscall
    mov edi, 1
    mov eax, 60
    syscall

; rt_read_float(): reads a decimal number such as 85.5, -3 or 0.25.
; The result is returned as the raw bit pattern of a double in RAX.
rt_read_float:
    push rbp
    mov rbp, rsp
    sub rsp, 512
    mov rsi, rsp
    mov edx, 512
    call rt_readline
    mov rsi, rsp
    xor rcx, rcx                  ; negative flag
    xor r8, r8                    ; digit count (integer and fraction)
    xor r9, r9                    ; fraction digit count
    xor rax, rax                  ; mantissa as an integer
.fskip:
    cmp byte [rsi], ' '
    jne .fsign
    inc rsi
    jmp .fskip
.fsign:
    cmp byte [rsi], '-'
    jne .fint
    mov rcx, 1
    inc rsi
.fint:
    movzx rdx, byte [rsi]
    sub rdx, '0'
    cmp rdx, 9
    ja .fdot
    imul rax, rax, 10
    add rax, rdx
    inc r8
    inc rsi
    jmp .fint
.fdot:
    cmp byte [rsi], '.'
    jne .fend
    inc rsi
.ffrac:
    movzx rdx, byte [rsi]
    sub rdx, '0'
    cmp rdx, 9
    ja .fend
    imul rax, rax, 10
    add rax, rdx
    inc r8
    inc r9
    inc rsi
    jmp .ffrac
.fend:
    test r8, r8
    jz .fbad
    cvtsi2sd xmm0, rax            ; mantissa as a double
    mov rdx, 0x3FF0000000000000   ; 1.0
    movq xmm1, rdx                ; divisor = 10^fraction digits
    mov rdx, 0x4024000000000000   ; 10.0
    movq xmm2, rdx
.fpow:
    test r9, r9
    jz .fscale
    mulsd xmm1, xmm2
    dec r9
    jmp .fpow
.fscale:
    divsd xmm0, xmm1
    movq rax, xmm0
    test rcx, rcx
    jz .fok
    btc rax, 63                   ; flip the sign bit
.fok:
    leave
    ret
.fbad:
    lea rsi, [rel rt_badfloat]
    mov edx, rt_badfloat_len
    mov edi, 2
    mov eax, 1
    syscall
    mov edi, 1
    mov eax, 60
    syscall

; rt_read_bool(): reads the word true or false; anything else is a runtime error
rt_read_bool:
    push rbp
    mov rbp, rsp
    sub rsp, 512
    mov rsi, rsp
    mov edx, 512
    call rt_readline              ; RAX = length
    mov rsi, rsp
    cmp rax, 4
    jne .bfalse
    cmp byte [rsi], 't'
    jne .bbad
    cmp byte [rsi+1], 'r'
    jne .bbad
    cmp byte [rsi+2], 'u'
    jne .bbad
    cmp byte [rsi+3], 'e'
    jne .bbad
    mov eax, 1
    jmp .bret
.bfalse:
    cmp rax, 5
    jne .bbad
    cmp byte [rsi], 'f'
    jne .bbad
    cmp byte [rsi+1], 'a'
    jne .bbad
    cmp byte [rsi+2], 'l'
    jne .bbad
    cmp byte [rsi+3], 's'
    jne .bbad
    cmp byte [rsi+4], 'e'
    jne .bbad
    xor eax, eax
.bret:
    leave
    ret
.bbad:
    lea rsi, [rel rt_badbool]
    mov edx, rt_badbool_len
    mov edi, 2
    mov eax, 1
    syscall
    mov edi, 1
    mov eax, 60
    syscall

; rt_alloc(rdi = size): bump allocator over rt_heap, returns pointer in RAX
rt_alloc:
    mov rax, [rel rt_heap_top]
    test rax, rax
    jnz .ready
    lea rax, [rel rt_heap]
.ready:
    lea rdx, [rax + rdi + 7]
    and rdx, -8
    mov [rel rt_heap_top], rdx
    ret

; rt_read_str(): reads a line and returns a pointer to a heap copy in RAX
rt_read_str:
    push rbp
    mov rbp, rsp
    push rbx
    push r12
    sub rsp, 512
    mov rsi, rsp
    mov edx, 512
    call rt_readline
    mov r12, rax                  ; length
    lea rdi, [r12 + 1]
    call rt_alloc
    mov rbx, rax                  ; destination
    mov rdi, rax
    mov rsi, rsp
    lea rcx, [r12 + 1]            ; copy including the NUL
    rep movsb
    mov rax, rbx
    add rsp, 512
    pop r12
    pop rbx
    leave
    ret

; rt_streq(rdi, rsi): RAX = 1 if the two NUL-terminated strings are equal, else 0
rt_streq:
.loop:
    mov al, [rdi]
    cmp al, [rsi]
    jne .different
    test al, al
    jz .same
    inc rdi
    inc rsi
    jmp .loop
.different:
    xor eax, eax
    ret
.same:
    mov eax, 1
    ret

; rt_fail_divzero: runtime error for division or remainder by zero
rt_fail_divzero:
    lea rsi, [rel rt_divzero]
    mov edx, rt_divzero_len
    mov edi, 2
    mov eax, 1
    syscall
    mov edi, 1
    mov eax, 60
    syscall
