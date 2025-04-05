---
title: RAID (Redundant array of inexpensive disk)
draft: false
tags:
  - Disk
type: post
date: 2025-02-13T20:25:14+0530
category: Storage
---

# RAID Disks

Three axes on which disks are analysed
- Capacity - How much capacity is needed to store X bytes of data
- Reliability - How much fault-tolerant is the disk  
- Performance - Read and write speeds (Sequential and random)

To make a logical disk (comprising set of physical disks) reliable we need replication, so there is tradeoff with capacity and performance (write amplification)
When we talk about collection of physical disks representing one single logical disk we should know that there would be small compute and some non-volatile RAM also included to fully complete the disk controller component. This RAM is also used for WAL for faster writes similar to #Database 
In a way this set of disks also have challenges similar to distributes databases.

There are different types of data arrangement in set of physical disks which results in different types/levels of RAID
## RAID Level 0 - Striping

| Disk 0 | Disk 1 | Disk 2 | Disk 3 |
| ------ | ------ | ------ | ------ |
| 0      | 1      | 2      | 3      |
| 4      | 5      | 6      | 7      |
| 8      | 9      | 10     | 11     |
| 12     | 13     | 14     | 15     |
> Here each cell is a disk block which will be of fixed size (for example 4KB)
> A vertical column shows blocks stored by a single disk

**Striping**: Writing out chunks (in multiple of disk block size) to each disk, one at a time so that we have the data spread uniformly across the disk.
When read or write requests comes up to disk it comes in the form of **stripe number** *(row number in above illustration)* and based on RAID level disk controller knows which block it has to access and which disk to read it from.

Tradeoffs:
- This level has no reliability as a disk failure always means loss of some data.
- This arrangement is good for capacity as we are utilizing all disks for storage.

## RAID Level 1 - Mirroring
| Disk 0 | Disk 1 | Disk 2 | Disk 3 |
| ------ | ------ | ------ | ------ |
| 0      | 0      | 1      | 1      |
| 2      | 2      | 3      | 3      |
| 4      | 4      | 5      | 5      |
| 6      | 6      | 7      | 7      |
Copies of blocks made to two disks, tradeoff of reliability over capacity.

### Consistent update problem
> Imagine the write is issued to the RAID, and then the RAID decides that it must be written to two disks, disk 0 and disk 1. The RAID then issues the write to disk 0, but just before the RAID can issue the request to disk 1, a power loss (or system crash) occurs. In this unfortunate case, let us assume that the request to disk 0 completed (but clearly the request to disk 1 did not, as it was never issued). The result of this untimely power loss is that the two copies of the block are now inconsistent; the copy on disk 0 is the new version, and the copy on disk 1 is the old. What we would like to happen is for the state of both disks to change atomically, i.e., either both should end up as the new version or neither. The general way to solve this problem is to use a write-ahead log of some kind to first record what the RAID is about to do (i.e., update two disks with a certain piece of data) before doing it. By taking this approach, we can ensure that in the presence of a crash, the right thing will happen; by running a recovery procedure that replays all pending transactions to the RAID, we can ensure that no two mirrored copies (in the RAID-1 case) are out of sync. One last note: because logging to disk on every write is prohibitively expensive, most RAID hardware includes a small amount of non-volatile RAM (e.g., battery-backed) where it performs this type of logging. Thus, consistent update is provided without the high cost of logging to disk.


Tradeoffs:
- This level can tolerate up to N/2 disk failures.
- This arrangement is good for reliability over cost of capacity being half
- Even though updates for a block needs to happen at two separate disks, The write would be parallel but still slower than updating a single disk (If we consider different seek and rotational time for both disks)

## RAID Level 4 - Parity

| Disk 0 | Disk 1 | Disk 2 | Disk 3 | Disk 4 |
| ------ | ------ | ------ | ------ | ------ |
| 0      | 1      | 2      | 3      | **P0** |
| 4      | 5      | 6      | 7      | **P1** |
| 8      | 9      | 10     | 11     | **P2** |
| 12     | 13     | 14     | 15     | **P3** |
N - 1 Disks follow striping with the Nth disk containing parity block for each strip row
**Concept:** RAID 4 adds redundancy to a disk array using parity, which consumes less storage space than mirroring.

**How it works:**
- A single parity block is added to each stripe of data blocks.
- The parity block stores redundant information calculated from the data blocks in its stripe.
- The XOR function is used to calculate parity. XOR returns 0 if there are an even number of 1s in the bits, and 1 if there are an odd number of 1s.  
- The parity bit ensures that the number of 1s in any row, including the parity bit, is always even.

**Example of Parity Calculation:**
Imagine a RAID 4 system with 4-bit data blocks. Let's say we have the following data in one stripe:

- Block 0: `0010`
- Block 1: `1001`
- Block 2: `0110`
- Block 3: `1011`

To calculate the parity block, we perform a bitwise XOR across the corresponding bits of each data block:
- **Bit 1 (from left):** 0 XOR 1 XOR 0 XOR 1 = 0
- **Bit 2:** 0 XOR 0 XOR 1 XOR 0 = 1
- **Bit 3:** 1 XOR 0 XOR 1 XOR 1 = 1
- **Bit 4:** 0 XOR 1 XOR 0 XOR 1 = 0

Therefore, the parity block would be `0110`.

**Data recovery:**
- If a data block is lost, the remaining blocks in the stripe, including the parity block, are read.
- The XOR function is applied to these blocks to reconstruct the missing data. For example, if Block 2 (`0110`) was lost, we would XOR Block 0, Block 1, Block 3, and the parity block: `0010` XOR `1001` XOR `1011` XOR `0110` = `0110`.

**Performance:**
- RAID 4 has a performance cost due to the overhead of parity calculation. Crucially, all write operations must update the parity disk.
- **Write Bottleneck:** If multiple random write requests comes for various blocks at the same time then they all will all require to update different parity blocks but all parity blocks are in one disk so multiple updates to different parity block will be done one after the other because all are in the same disk which eventually makes concurrent random write requests sequential in nature ***this is also known as small-write problem***

## RAID Level 5 - Rotating Parity

Instead of having one dedicated disk for parity blocks for each stripe, distribute the parity blocks in rotating manner to all disks for each stripe.

| Disk 0 | Disk 1 | Disk 2 | Disk 3 | Disk 4 |
| ------ | ------ | ------ | ------ | ------ |
| 0      | 1      | 2      | 3      | **P0** |
| 4      | 5      | 6      | **P1** | 7      |
| 8      | 9      | **P2** | 10     | 11     |
| 12     | **P3** | 13     | 14     | 15     |
**Small-write:** Concurrent random write requests to blocks of different blocks of different stripes can now be done parallelly since parity block for each stripe will be in different disk.
It is still possible that blocks of different stripes need to update parity blocks which are lying in same disk (due to rotating nature of parity block)
*write requests to blocks of same stripes will still be sequential since parity block will be on same disk for all the blocks of same stripe.*

**In summary:** While RAID 5 significantly improves random write performance compared to RAID 4, it doesn't completely eliminate the possibility of parity-related bottlenecks. The rotated parity distribution reduces the _likelihood_ of contention, but it doesn't guarantee that parity updates will always be fully parallel. The chance of multiple stripes' parity residing on the same disk is still there, leading to potential performance degradation.
# References

https://pages.cs.wisc.edu/~remzi/OSTEP/file-raid.pdf
How Data recovery happens with parity drive in RAID: https://blogs.oracle.com/solaris/post/understanding-raid-5-recovery-with-elementary-school-math#:~:text=We%20need%20to%20read%20all%20date%20from%20other%20drives%20to%20recovery%20parity.