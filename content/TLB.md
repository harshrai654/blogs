---
title: TLB
draft: false
tags:
  - OS
  - Cache
  - Memory
  - Virtualisation
type: post
date: 2025-04-05T20:27:06+0530
category: Operating System
---


# TLB

Translation look-aside buffer is a CPU cache which is generally small but since it is closer to CPU a TLB hit results in address translation to happen in 1-5 CPU cycles.
> CPU Cycle
> Time taken by CPU to fully execute an instruction, while CPU frequency refers to the number of these cycles that occur per second

A TLB hit means for given virtual address the physical frame number was found in the TLB cache. A TLB hit will benefit all the address that lie on the same page.
![Pasted image 20241120223520.png](/media/pasted-image-20241120223520.png)
In the above given image page size is 16 bytes, so 4 INT variables can be saved in a single page, so a TLB hit of VPN 07 will serve address translation for VPN = 07 + page of offset of 0, 4,8 and 12 byte.
This type of caching is benefitted from ***spatial locality*** of data where a cache hit results in cache hits for surrounding data as well.
If we cache data and other data points which are more probable to get accessed in the same time frame (like loop variables etc) then such caching is benefitted from ***Temporal locality.***

### Software (OS) handled TLB miss

^3bbded

When a TLB miss happens
1. Generate a trap
2. Trap handler for this trap is OS code.
3. This trap handler will find the translation of virtual address from page table stored in memory
4. A privileged operation to update the TLB
5. Return to trap with PC updated to same instruction which generated the trap. *(Usually return to trap updates PC to next instruction address)*
### Context Switch and TLB
- A naive approach is to flush the TLB (by setting valid bit of the page table entry to 0) so that the next yet to run process has a clean TLB, but this can slow things down since after every context switch new process will have few TLB misses, and we have high frequency of context switches then the performance may degrade.
- Another approach is to use same TLB for multiple processes with a Address space identifier (ASID, similar to PID but small) in the page table entry signifying the process to which a page table entry belongs
- Using cache replacement policies like LRU for page table entries 


# References

https://pages.cs.wisc.edu/~remzi/OSTEP/vm-tlbs.pdf



