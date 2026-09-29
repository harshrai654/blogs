---
title: XV6 boot 1
draft: false
tags:
  - OS
  - Memory
  - Virtualisation
type: post
date: 2026-09-29T14:39:41+0530
category: Operating System
---
# From Power-On to C: How xv6 Boots on RISC-V (Part 1)

After finishing [Operating Systems: Three Easy Pieces (OSTEP)](https://pages.cs.wisc.edu/~remzi/OSTEP/) and experimenting with various Linux interfaces and system calls, I wanted to get my hands dirty with an actual operating system kernel codebase. OSTEP frequently points to xv6 for this, and to connect the theoretical concepts: virtual memory, page tables, traps, and scheduling, with real hardware and code, I have been diving into the xv6 kernel alongside [MIT's 6.S081 / 6.828 Operating System Engineering course](https://pdos.csail.mit.edu/6.828/2021/schedule.html). This is the start of a multi-part series where I document my notes, walk through the source code, and explain how things actually work under the hood.

When we type `make qemu` on our host machine—say, a MacBook running macOS on an Apple Silicon M-series chip—our physical CPU does not understand a single byte of RISC-V machine code. Our Mac runs on ARM64, while xv6 is compiled strictly as a 64-bit RISC-V (`rv64gc`) binary. Yet, within a fraction of a second, an interactive Unix shell prompt appears on our terminal.
To understand how an operating system boots on bare metal, we have to start at the very beginning: before there is a stack, before virtual memory exists, before any C code can run, and even before the first instruction of the kernel executes.
In this first post, we will trace the journey from the moment QEMU powers on its virtual hardware to the exact instruction that leaps into C code (`start.c`).

---
## 1. Emulating Hardware: How QEMU Runs RISC-V on macOS

Because our host hardware is ARM64, running `qemu-system-riscv64` requires full-system emulation. QEMU does not execute guest RISC-V instructions directly on our physical CPU cores. Instead, it uses its **Tiny Code Generator (TCG)**, an internal dynamic binary translation engine.

![QEMU RISC-V Emulation Pipeline](media/qemu_emulation.jpg)

When QEMU runs:
1. **CPU State in Host RAM:** QEMU models the virtual RISC-V CPU in software. The 32 general-purpose registers (`zero`, `ra`, `sp`, `gp`, `tp`, `t0-t6`, `s0-s11`, `a0-a7`), the program counter (`pc`), and the Control and Status Registers (CSRs like `mstatus`, `satp`, `mtvec`) are simply member fields inside a C struct (`CPURISCVState`) allocated on our Mac's heap.

2. **Dynamic JIT Translation:** As the virtual CPU reads guest 32-bit RISC-V instructions, TCG translates basic blocks of RISC-V instructions into an architecture-independent intermediate representation (IR), optimises them, and JIT-compiles them into native host instructions (ARM64 on Apple Silicon, x86_64 on Intel) cached in executable memory.

3. **Motherboard Modelling (`-machine virt`):** xv6 launches QEMU with the flag `-machine virt`. This tells QEMU to construct a standard virtual RISC-V development motherboard featuring:
	- Multiple CPU cores (called **harts**, short for *hardware threads*).
	- A Core Local Interruptor (**CLINT**) at `0x02000000` handling timer interrupts.
	- A Platform-Level Interrupt Controller (**PLIC**) at `0x0C000000` handling device interrupts.
	- Memory-Mapped I/O (**MMIO**) peripherals, such as a 16550A UART serial controller at `0x10000000` and VirtIO disk interfaces at `0x10001000`.
	- Physical DRAM beginning at `0x80000000` (`KERNBASE`).

---

## 2. The Boot ROM & The Magic Address `0x80000000`

When any computer powers on—whether a physical motherboard or a QEMU virtual machine—the CPU registers contain uninitialized garbage, and the program counter cannot point to arbitrary memory because RAM has not even been configured yet.
Physical hardware solves this with a **Boot ROM**: a small, read-only memory chip wired directly to the CPU's initial reset vector. When power is applied, hardware logic forces the program counter (`pc`) to point directly to this ROM.


In QEMU's RISC-V `virt` board (defined in `hw/riscv/virt.c` and documented in xv6's [kernel/memlayout.h#L7-L14](https://github.com/harshrai654/xv6/blob/main/kernel/memlayout.h#L7-L14)), the physical memory layout is wired as follows:

```text

0x00001000 ──► QEMU Boot ROM (CPU reset vector lands here)
0x02000000 ──► CLINT (Timer registers)
0x0C000000 ──► PLIC (External device interrupts)
0x10000000 ──► UART0 (Serial console)
0x10001000 ──► VirtIO (Disk controller)
0x80000000 ──► RAM begins (DRAM / KERNBASE)
```

Notice the division at `0x80000000`:
- Everything **below** `0x80000000` is reserved for Memory-Mapped I/O (MMIO) and internal chips. Reading or writing here talks directly to hardware controllers.
- Everything **at and above** `0x80000000` is physical RAM.
### What Does QEMU's Boot ROM Do?

When QEMU starts, every virtual hart begins executing at `0x00001000` inside QEMU's hardcoded Boot ROM. The Boot ROM contains just a few instructions:
1. It queries the hardware to determine the hart ID (`mhartid`).
2. It sets up minimal device-tree pointers.
3. It performs a direct jump to address `0x80000000`:

```assembly
# Conceptual instructions executed inside QEMU Boot ROM
li t0, 0x80000000
jr t0
```

### How Does the Kernel Binary Get to `0x80000000`?

In xv6's `Makefile`, QEMU is invoked with:

```bash

qemu-system-riscv64 -machine virt -bios none -kernel kernel/kernel ...

```

The `-kernel kernel/kernel` argument is the bridge. Before QEMU starts executing instructions, its internal ELF loader inspects the compiled `kernel/kernel` binary on our host disk. It reads the ELF program headers and copies the binary's executable code and data sections directly into the virtual machine's RAM starting at physical address `0x80000000`.

> When the CPU resets to `0x00001000`, it executes a few instructions in the Boot ROM and immediately jumps to `0x80000000`. Because QEMU pre-loaded our kernel at `0x80000000`, that jump lands squarely on the very first instruction of our operating system.

---
## 3. RISC-V Privilege Modes: Where Are We Right Now?

When the CPU arrives at `0x80000000`, what can it do, and what rules constrain it?
RISC-V defines three distinct hardware privilege modes:

| Mode       | Name            | Primary Use                           | Address Translation             |
| :--------- | :-------------- | :------------------------------------ | :------------------------------ |
| **M mode** | Machine Mode    | Bare-metal setup, hardware traps      | None (Physical addresses only)  |
| **S-mode** | Supervisor Mode | Operating System Kernel (xv6)         | Sv39 Paging enabled via `satp`  |
| **U mode** | User Mode       | User applications (`sh`, `ls`, `cat`) | Isolated virtual address spaces |

Why not run everything in one mode?

If user programs could execute any CPU instruction, a rogue program could disable interrupts, overwrite page table registers, or read kernel memory. Hardware privilege levels enforce strict fault boundaries:
- **U-mode** code can only touch pages marked with the User bit (`PTE_U`) and cannot execute privileged instructions.
- **S-mode** is where the xv6 kernel spends almost all its life—managing page tables, interacting with drivers, and isolating user processes.

However, at CPU reset, **the hardware starts in Machine Mode (M-mode)**.
In M-mode:
- Paging is completely disabled (`satp` is 0).
- Every memory address is a raw physical address.
- We have unrestricted access to all Control and Status Registers (CSRs).

Our goal during early boot is to use M-mode just long enough to configure the bare-metal hardware and set up a C stack, and then immediately drop down to S-mode where the real operating system runs.

---
## 4. The Blueprint: How the Toolchain and `kernel.ld` Build the Kernel

We know QEMU jumps to `0x80000000`. But how does our build system guarantee that the first instruction of our kernel is actually placed at byte `0x80000000`? And how do assembly files (`.S`) and C files (`.c`) talk to each other to produce a single kernel binary?

To understand this, we need to look at how the GNU toolchain compiles and links xv6.

### How C and Assembly Become Object Files
When we run `make`, the compiler doesn't build the kernel in one giant step. Instead, it compiles each source file into an independent ELF object file (`.o`):
- C files (`main.c`, `start.c`, `vm.c`) are compiled via `riscv64-unknown-elf-gcc` into `main.o`, `start.o`, `vm.o`.
- Assembly files (`entry.S`, `kernelvec.S`, `trampoline.S`) are also assembled by `gcc` (which invokes the assembler `gas`) into `entry.o`, `kernelvec.o`, etc.

Every `.o` file contains:
1. **Sections:** Chunks of machine code (`.text`), initialized data (`.data`), and zeroed storage declarations (`.bss`).
2. **A Symbol Table (`.symtab`):** A dictionary of all functions and global variables defined or referenced in that file.
3. **A Relocation Table (`.rela`):** A list of placeholders where an instruction needs an address that wasn't known at compile time (for example, when `entry.S` references `stack0` defined in `start.c`).

At this stage, an object file has no idea where it will reside in physical RAM; its sections are simply offset from address `0x0`.

### Invoking the Linker in the Makefile
To combine these separate `.o` files into the final executable `kernel/kernel`, the xv6 [Makefile#L126-L128](https://github.com/harshrai654/xv6/blob/main/Makefile#L126-L128) runs the GNU Linker (`ld`):

```makefile
$K/kernel: $(OBJS) $(OBJS_KCSAN) $K/kernel.ld $U/initcode
	$(LD) $(LDFLAGS) -T $K/kernel.ld -o $K/kernel $(OBJS) $(OBJS_KCSAN)
```

Look closely at two details here:
1. **The `-T $K/kernel.ld` flag:** By default, `ld` uses an internal script tailored for regular user programs running on an OS like Linux. The `-T` flag tells the linker: *"Discard your default layout. Use our custom linker script (`kernel/kernel.ld`) to place every section in memory."*
2. **The Order of Objects in `OBJS`:** In the `Makefile`, `OBJS` explicitly lists `$K/entry.o` as the **very first object**:
   ```makefile
   OBJS = \
     $K/entry.o \
     $K/kalloc.o \
     $K/string.o \
     $K/main.o \
     ...
   ```
   Because `entry.o` is listed first, its `.text` section is placed at the start of the final `.text` segment.

### Deep Dive into `kernel.ld`
The **Linker Script** ([kernel/kernel.ld](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld)) is the architectural blueprint for the final binary:

```ld
OUTPUT_ARCH( "riscv" )
ENTRY( _entry )

SECTIONS
{
  /*
   * ensure that entry.S / _entry is at 0x80000000,
   * where qemu's -kernel jumps.
   */
  . = 0x80000000;

  .text : {
    *(.text .text.*)
    . = ALIGN(0x1000);
    _trampoline = .;
    *(trampsec)
    . = ALIGN(0x1000);
    ASSERT(. - _trampoline == 0x1000, "error: trampoline larger than one page");
    PROVIDE(etext = .);
  }

  .rodata : {
    . = ALIGN(16);
    *(.srodata .srodata.*) /* do not need to distinguish this from .rodata */
    . = ALIGN(16);
    *(.rodata .rodata.*)
  }

  .data : {
    . = ALIGN(16);
    *(.sdata .sdata.*) /* do not need to distinguish this from .data */
    . = ALIGN(16);
    *(.data .data.*)
  }

  .bss : {
    . = ALIGN(16);
    *(.sbss .sbss.*) /* do not need to distinguish this from .bss */
    . = ALIGN(16);
    *(.bss .bss.*)
  }

  PROVIDE(end = .);
}
```

Let's dissect this file line by line to see what it is doing:

#### 1. How `ENTRY(_entry)` Connects to Assembly
* [kernel/kernel.ld#L1-L2](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld#L1-L2):
  ```ld
  OUTPUT_ARCH( "riscv" )
  ENTRY( _entry )
  ```
  In `entry.S`, we have the directive `.global _entry`. This marks `_entry` as an exported global symbol in `entry.o`'s symbol table. 
  When the linker processes `ENTRY(_entry)`, it searches through all input `.o` symbol tables, finds `_entry` in `entry.o`, and writes its final address into the ELF header's entry point field (`e_entry`). Any tool reading this ELF binary (including QEMU's `-kernel` loader or a debugger like GDB) knows that execution is intended to begin at `_entry`.

#### 2. Setting the Location Counter to `0x80000000`
* [kernel/kernel.ld#L10](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld#L10):
  ```ld
  . = 0x80000000;
  ```
  In GNU linker scripts, `.` is the **location counter**. Setting `. = 0x80000000` tells the linker: *"Place the upcoming section starting at physical address `0x80000000`."*
  Because `entry.o` is linked first, its `.text` section—beginning with `_entry`—lands at the very first byte (`0x80000000`). When QEMU jumps to `0x80000000`, it lands directly on `_entry`.

#### 3. The `.text` Section & The Trampoline
* [kernel/kernel.ld#L12-L20](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld#L12-L20):
  ```ld
  .text : {
    *(.text .text.*)
    . = ALIGN(0x1000);
    _trampoline = .;
    *(trampsec)
    . = ALIGN(0x1000);
    ASSERT(. - _trampoline == 0x1000, "error: trampoline larger than one page");
    PROVIDE(etext = .);
  }
  ```
  - `*(.text .text.*)` gathers executable code from all compiled files.
  - `. = ALIGN(0x1000);` aligns the location counter to a 4KB page boundary (`4096 = 0x1000` bytes).
  - `*(trampsec)` inserts the assembly code from `trampoline.S`.
  - `ASSERT(. - _trampoline == 0x1000, ...)` guarantees that the trampoline code is **exactly one page** in size. If someone accidentally makes the trampoline larger than 4KB, the build fails immediately.
  - `PROVIDE(etext = .);` exports a global symbol `etext` recording the exact address where executable code ends. Later, in `vm.c`, the kernel uses `etext` to set page permissions: pages between `0x80000000` and `etext` are mapped with Read + Execute permissions (`PTE_R | PTE_X`), preventing code from being modified at runtime.

#### 4. Data Sections and Alignment
* [kernel/kernel.ld#L22-L42](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld#L22-L42):
  - `.rodata`: Read-only data (such as string constants like `"xv6 kernel is booting\n"`).
  - `.data`: Initialized global and static variables.
  - `.bss`: Uninitialized or zero-initialized global variables (e.g., process table arrays, lock structures).
  - Each section is aligned to 16 bytes (`ALIGN(16)`), matching standard 64-bit calling convention alignment requirements.

#### 5. Exporting `end`
* [kernel/kernel.ld#L44](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld#L44):
  ```ld
  PROVIDE(end = .);
  ```
  This is a critical boundary marker. `end` marks the exact physical address where the kernel's static binary terminates in RAM.
  Everything from `end` up to `PHYSTOP` (`0x88000000` = 128MB) is free, unallocated physical memory. Later on, the physical memory allocator (`kalloc.c`) will use `end` as the starting point for its free-page linked list:

![kernel_memory.jpg](/media/kernel_memory.jpg)

---

## 5. First Instructions: `entry.S` (Machine-Mode Assembly)

Now that `kernel.ld` has placed our code at `0x80000000`, the virtual CPU jumps in.
### The Problem: Why Can't We Jump Directly to C?

When the CPU lands at `0x80000000`, the CPU registers hold undefined values. Most importantly:
**The Stack Pointer register (`sp`) is uninitialized.**
In C, calling a function pushes the return address and local variables onto a stack. If we try to execute C code without a valid stack pointer, the very first function prologue (`addi sp, sp, -32`) will write to random memory, corrupting state or crashing the machine immediately.
Therefore, the first task of an operating system must always be written in assembly: **set up a valid stack pointer and jump to C**.

Here is the complete source of [kernel/entry.S](https://github.com/harshrai654/xv6/blob/main/kernel/entry.S):
```s
	# qemu -kernel loads the kernel at 0x80000000
        # and causes each CPU to jump there.
        # kernel.ld causes the following code to
        # be placed at 0x80000000.
.section .text
.global _entry
_entry:
	# set up a stack for C.
        # stack0 is declared in start.c,
        # with a 4096-byte stack per CPU.
        # sp = stack0 + (hartid * 4096)
        la sp, stack0
        li a0, 1024*4
	csrr a1, mhartid
        addi a1, a1, 1
        mul a0, a0, a1
        add sp, sp, a0
	# jump to start() in start.c
        call start
spin:
        j spin

```

Let's trace these instructions step-by-step.
### Step 1: Where Does the Stack Memory Come From?

In [kernel/start.c#L11](https://github.com/harshrai654/xv6/blob/main/kernel/start.c#L11), xv6 declares a dedicated global array:

```c

__attribute__ ((aligned (16))) char stack0[4096 * NCPU];

```

- `NCPU` is 8 (the maximum number of supported CPU cores).
- Each CPU core gets its own **4096-byte (4KB)** stack slice.
- `stack0` is allocated in the `.bss` section of the kernel binary.

#### How Does Assembly Access a Variable Declared in C?
Notice that `stack0` is defined in a C file (`start.c`), yet `entry.S` directly loads its address via `la sp, stack0`. How does the toolchain bridge this?

1. **C Symbol Export:** In C, any variable declared globally outside of functions without the `static` keyword has external linkage (`STB_GLOBAL`). When `gcc` compiles `start.c` into `start.o`, it reserves space in the `.bss` section and records `stack0` as a global symbol in `start.o`'s symbol table (`.symtab`). Because C does not mangle names (unlike C++), the symbol is stored simply as the ASCII string `"stack0"`.
2. **Assembly External Reference:** When the assembler processes `entry.S`, it encounters `la sp, stack0`. Since `stack0` is not defined anywhere in `entry.S`, the assembler cannot know its numerical address yet. It flags `stack0` as an unresolved reference in `entry.o`'s symbol table and emits a **relocation entry** (specifically, a pair of instructions: `auipc` and `addi`).
3. **Linker Resolution:** When the linker (`ld`) executes, it scans both `entry.o` and `start.o`. It matches the unresolved reference in `entry.o` with the symbol definition in `start.o`, computes the final physical memory address of `stack0` based on `kernel.ld`, and patches the immediate fields of the instructions in `entry.o`.

### Step 2: The Multi-Core Stack Calculation

When QEMU powers on with multiple cores, **every core executes `_entry` simultaneously**.

If every CPU used the same stack memory, they would immediately overwrite each other's return addresses and local variables—a catastrophic race condition. Every hart needs its own unique stack pointer.

Furthermore, in RISC-V, **stacks grow downward** from high memory to low memory. When pushing data, the CPU subtracts from `sp`. This means `sp` must be initialized pointing to the **top** (highest address) of each hart's 4KB buffer.

Let's look at the assembly arithmetic:

```assembly
la sp, stack0       # 1. Load base address of stack0 array into sp
li a0, 1024*4       # 2. a0 = 4096 (size of one CPU stack)
csrr a1, mhartid    # 3. Read the hardware thread ID (0, 1, 2, ...) into a1
addi a1, a1, 1      # 4. a1 = hartid + 1
mul a0, a0, a1      # 5. a0 = (hartid + 1) * 4096
add sp, sp, a0      # 6. sp = stack0 + ((hartid + 1) * 4096)
```

Let's calculate this with concrete numbers. Assume `stack0` begins at address `0x80010000`:

* **For Hart 0 (`mhartid = 0`):**
  $$\text{multiplier} = 0 + 1 = 1$$
  $$\text{offset} = 1 \times 4096 = 4096\ (\text{0x1000})$$
  $$\text{sp}_0 = 0x80010000 + 0x1000 = \mathbf{0x80011000}$$
  *Hart 0's stack occupies `0x80010000` to `0x80011000`. As it pushes variables, it grows downward toward `0x80010000`.*

* **For Hart 1 (`mhartid = 1`):**
  $$\text{multiplier} = 1 + 1 = 2$$
  $$\text{offset} = 2 \times 4096 = 8192\ (\text{0x2000})$$
  $$\text{sp}_1 = 0x80010000 + 0x2000 = \mathbf{0x80012000}$$
  *Hart 1's stack occupies `0x80011000` to `0x80012000`.*

![stack.jpg](/media/stack.jpg)

#### Can CPU 1 Overflow into CPU 0's Stack?
Looking at the memory diagram, an astute systems engineer might ask: *What prevents Hart 1's stack from growing so large that its `sp` crosses the 4KB boundary and starts overwriting Hart 0's stack?*

The honest answer: **Nothing in hardware prevents this at this early stage!**

Remember that we are executing in Machine Mode with **paging turned off**. Memory is just raw, flat DRAM. There are no virtual memory page tables and no unmapped guard pages between Hart 0's buffer and Hart 1's buffer. If Hart 1 pushed more than 4096 bytes of stack frames, its `sp` *would* decrement into Hart 0's stack and corrupt it.

Why does xv6 get away with this?
Because `start()` in `start.c` is intentionally tiny and carefully written:
- It allocates no large local variables or arrays.
- It performs zero recursive calls.
- It calls only `timerinit()` and executes a few CSR writes before transitioning to Supervisor mode.
In practice, `start()` uses only a few dozen bytes of stack space, safely below the 4096-byte limit.

> Later, when xv6 allocates *per-process kernel stacks* in Supervisor mode (`proc_mapstacks()` in `proc.c`), it explicitly surrounds each kernel stack with an unmapped 4KB guard page in kernel page table so that stack overflow causes an immediate hardware page fault panic. But at this early M-mode stage, stack safety is guaranteed purely by keeping `start()` lean.

---

## 6. From Assembly to C: The Leap to `start.c`

With a private stack pointer established for each core, the CPU can now safely execute compiled C functions:

* [kernel/entry.S#L19-L21](https://github.com/harshrai654/xv6/blob/main/kernel/entry.S#L19-L21):
  ```assembly
  call start
spin:
  j spin
  ```

Let's look at what these two lines are actually doing at the machine level:

### 1. `call start` (The Subroutine Call)
In RISC-V assembly, `call start` is a pseudo-instruction that expands into a pair of instructions:
```assembly
auipc ra, offset_high
jalr  ra, ra, offset_low
```
This performs two distinct actions:
1. It computes the address of the very next instruction (`spin: j spin`) and saves it into the **Return Address register (`ra`)**.
2. It jumps to the first instruction of `start()` in `kernel/start.c`.

### 2. Why `start()` Never Returns
In a standard C program, when a function reaches its closing brace or a `return` statement, the compiler generates a `ret` instruction (which is `jalr zero, 0(ra)`). This jumps back to the address stored in `ra`, resuming execution right after the original call site.

However, `start()` is **never supposed to return**. 

As we will see in the next post, `start()` configures Machine-mode registers, writes the address of `main` into the Machine Exception Program Counter (`mepc`), and terminates with:
```c
asm volatile("mret");
```
The `mret` (Machine Return) instruction is a hardware-level privilege transition. It drops the CPU from Machine Mode into Supervisor Mode and forces the program counter (`pc`) to jump directly to `main`. It completely ignores the return address in `ra`.

### 3. Why `spin: j spin` Is Essential
If `start()` never returns, why is `spin: j spin` placed immediately after `call start`?

Think of it as a safety trap for the CPU:
- What if someone introduces a bug in `start.c`—such as adding an accidental `return;` statement, or what if `mret` fails?
- The CPU would execute the standard C function epilogue, pop the stack, and branch back to `ra`—which points directly to line 20 of `entry.S`.

Without `spin: j spin`, the CPU's program counter would fall through into whatever random bytes follow `entry.S` in memory. It would begin decoding arbitrary data or other kernel functions as instructions, causing erratic CPU behavior, silent memory corruption, or hard-to-debug crashes.

`spin: j spin` is an unconditional branch to itself (`j spin` jumps back to `spin` forever):
```assembly
spin:
    j spin   # Infinite loop: pc = spin
```
If `start()` ever returns due to a bug, the CPU core is immediately trapped in this harmless infinite loop—effectively "parking" the faulty CPU core safely without affecting the rest of the system.

At this exact moment, bare-metal assembly has finished its job. Control has officially been handed over to C code in `start.c`.

---
## Summary of the Boot Sequence So Far

Here is what we have established from power-on to the first C instruction:

| Stage | Hardware / File | Active State | Key Action |
| :--- | :--- | :--- | :--- |
| **1. Power-On** | QEMU TCG | M-mode, Paging OFF | Simulates virtual board, sets PC to Boot ROM `0x00001000` |
| **2. Binary Loading** | `-kernel` flag | Host filesystem | Parses kernel ELF, copies binary into RAM at `0x80000000` |
| **3. Boot ROM Jump** | QEMU ROM | M-mode, PC `0x00001000` | Initializes hart ID, executes `jr 0x80000000` |
| **4. Layout Placement** | `kernel.ld` | Linker Script | Guarantees `_entry` is at `0x80000000`, bounds `.text` with `etext`, marks `end` |
| **5. Stack Setup** | `entry.S` | M-mode, PC `0x80000000` | Computes `sp = stack0 + (hartid + 1) * 4096` |
| **6. The Hand-off** | `entry.S` $\to$ `start.c` | M-mode, C stack ready | Executes `call start` |

---

## What Comes Next?

We are now running C code in `start.c`, but we are still operating in **Machine Mode** with paging turned off.

In the next post, we will examine:

1. How `start.c` configures Machine-mode timer interrupts and delegates traps.
2. The clever `mret` trick used to drop privilege from Machine mode into Supervisor mode.
3. How `main.c` orchestrates all subsystems, boots multi-core harts, allocates the kernel page table (`vm.c`), and installs the kernel trap vector (`trap.c`).

---
## References & Code Links

- [Makefile#L126-L128](https://github.com/harshrai654/xv6/blob/main/Makefile#L126-L128) — Linking rule passing `-T kernel/kernel.ld` to the linker
- [kernel/kernel.ld](https://github.com/harshrai654/xv6/blob/main/kernel/kernel.ld) — Full linker script defining sections and memory boundaries
- [kernel/entry.S](https://github.com/harshrai654/xv6/blob/main/kernel/entry.S) — Initial assembly entry point and per-core stack pointer computation
- [kernel/start.c#L11](https://github.com/harshrai654/xv6/blob/main/kernel/start.c#L11) — Declaration of `stack0` buffer
- [kernel/memlayout.h#L7-L14](https://github.com/harshrai654/xv6/blob/main/kernel/memlayout.h#L7-L14) — QEMU `virt` board physical memory map