---
title: Page Tables
draft: false
tags:
  - Memory
  - Pagetable
  - OS
  - Virtualisation
type: post
date: 2024-11-17T20:22:15+0530
category: Operating System
---

# Page Tables
Page table contains the translation information of virtual page number to physical frame number. 
For an address space of 32 bits and page size of 4 KB *(i.e. memory of 2^32 is divided into segments of 4 KB where each segment is called a memory page)* , The virtual address will be of size 32 bits of which 12 bits (2^12 = 4 KB) will be used as offset inside a single page whereas remaining 20 bits will be used as virtual page number

## Example Memory Access

![page-table-translation.excalidraw.svg](/media/page-table-translation.excalidraw.svg)

As it can be seen from the above memory access flow, translating and accessing a virtual page address to actual physical frame address requires 2 memory access which can be slow when the process assumed that it is making only one memory access to fetch data or instruction from memory.

- Page table size is directly proportional to address space size
- Page table size is inversely proportional to a page size
# References

[OSTEP](https://pages.cs.wisc.edu/~remzi/OSTEP/vm-paging.pdf)



