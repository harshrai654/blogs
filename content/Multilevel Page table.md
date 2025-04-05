---
title: Multilevel Page table
draft: false
tags:
  - Memory
  - Pagetable
  - OS
  - Cache
  - Virtualisation
type: post
date: 2025-04-05T20:29:34+0530
category: Operating System
---


# Segmented Page Table

Page table can grow large for a 32-bit address space and 4 KB page size we will be using 20 bits for virtual page number resulting in 2^20 bytes (i.e. 4MB of page table) for a single page table and each process will have its own page table so it is possible that we will be storing ~100sMB for page table alone which is not good.
![Pasted image 20241127093849.png](/media/pasted-image-20241127093849.png)
For above page table with 4 bits for VPN (Virtual page number) we can see that only VPN 0,4,14 and 15 are valid i.e. pointing to a PFN (Physical Frame Number) other PTEs (Page table entry) are just taking up space which is not used.
We can use segmentation here with base and bound registers for each page table to only store valid PTE in the table. 
![Pasted image 20241127094506.png](/media/pasted-image-20241127094506.png)
This will again split the virtual address to also contain the segment bits to identify which segment the address belongs to (code, heap or stack). Instead of using *Base Page Table Register* to query page table we will now be using *Base Page Table Register [Segment]* to get page table physical address for a given segment.
```
SN = (VirtualAddress & SEG_MASK) >> SN_SHIFT 
VPN = (VirtualAddress & VPN_MASK) >> VPN_SHIFT 
AddressOfPTE = Base[SN] + (VPN * sizeof(PTE))
```

^3c2fde

This way we can place contents of a process's page table at different locations in memory for different segments and avoiding storing of invalid PTEs.

## Multilevel Page Table

Segmented page table still can suffer from space wastage if we have sparse usage of heap and can cause external fragmentation since now size of a page table segment can be different (multiple of PTE size) and finding free space for variable sized page table can be difficult.

Idea of Multilevel page table is to group page table entries into size of a page and ignore those group of PTE where each entry is invalid
![Pasted image 20241127095816.png](/media/pasted-image-20241127095816.png)
Like in above figure PFN 202 and 203 contain all entries as invalid and with multilevel page table we do not require to store PTE inside such pages.
Now we would have an indirection where we will first refer page directory and then the actual ***page of the page table*** to get physical frame number of a given virtual address. So in a way we now have *page table for the actual page table called **page directory***
Lets assume we have 14 bit address space with 4 byte PTE with 64 Byte page size. VPN will be of 8 bits, which means a linear page table will contain  256 PTE each of size 4 byte resulting in 1KB page table (4 * 256). A 1KB page table requires 16 pages of size of 32 bytes so we can group this page table intro 16 different segments which will be now addressed by page table directory.
To address 16 segments we need 4 bits so now we will be using first 4 bits of virtual address for page directory index.
> You can see the similarity with segmentation here with the only difference being we are now creating segments of page size, so everything will be in multiple of page sizes so we won't be facing external fragmentation + We do not need to know the number of segments beforehand like in segmentation with code, heap and stack.
![Pasted image 20241127101956.png](/media/pasted-image-20241127101956.png)

Similar to how we were calculating AddressOfPTE [[#^3c2fde]] in linear page table now we will first calculate AddressOfPDE (Page Directory Entry) as 
```
PDEAddr = PageDirBase + (PDIndex * sizeof(PDE)).
```
> Now we are storing page directory base address in register

Once we get PDE Address from there we can get the page address of required PTE.  Similar to concatenating page offset in linear page table now we will be concatenating rest of the bits after page directory index on virtual address (Page Table Index or Page offset of page-table's  page) with PDEAddress to get the physical address of the page table entry.
```
PTEAddr = (PDE.PFN << SHIFT) + (PTIndex * sizeof(PTE))
```

Once we get the PTE address we can concatenate the physical address inside the entry with the page offset in virtual address to finally get the physical address of the given virtual address.

## Summary

As you can see the tradeoff here is indirection to save memory space. Indirection basically means more number of memory access. For a given virtual address now we need following memory accesses:
- Access memory to fetch page directory address
- Access memory to fetch page table entry address from page directory index
- Finally access memory for given overall virtual address
As you can see with a TLB miss [[2- Source Materials/Books/OSTEP/TLB#^3bbded]] now we have 2 extra memory access overhead but after this miss we will have cache hit for this virtual address next time, and we will translate virtual address directly into physical address without any memory access.
Overall A bigger table such as linear page table means faster service in case of TLB miss (lesser memory access) and reducing page table with indirection means slower TLB miss service.
# References
https://pages.cs.wisc.edu/~remzi/OSTEP/vm-smalltables.pdf

