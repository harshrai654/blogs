---
title: B-Tree Latch Optimisation
draft: false
tags:
  - Database
  - Indexes
  - Mutex
  - Memory
type: post
date: 2024-11-17T12:08:00+0530
category: Database
---

# References

## 5.6 Problem
Generally when traversing the index made up of btree we have to take latch on it. In MySQL 5.6 the approach of taking latch depends on the possible operation we are doing:
- If the operation is a read operation then taking a read lock is sufficient to prevent any writes to happen to the pages we are accessing in Btree while reading
- If the operation is a write operation then there are again two possibilities:
	- ### Optimistic Locking
	   If the write is limited to modifying the leaf page only without modifying the structure of the tree (Merging OR Splitting) then it's an optimistic locking approach where we take read latch on root of the tree and write latch only on the leaf node to modify
	  ![Pasted image 20241117123300.png](/media/pasted-image-20241117123300.png) ^ab3c53
	- ### Pessimistic Locking
	  But if the operation result is in any type of restructuring of the tree itself then that will be known to us only after reaching the target leaf node and knowing its neighbours and parents. So the approach is first to try with optimistic locking defined above and then go for pessimistic locking
	  ![Pasted image 20241117123407.png](/media/pasted-image-20241117123407.png)
	  > **Pessimistic locking** involves taking a write latch on the root resulting in full ownership of the tree by the current operation (until the operation is complete no other operation can take a read or write latch, so all the other operations has to wait even if they are read operations and involve only optimistic locking). When the leaf node is found we take write latch on the leaf's neighbours as well as its parent and do the restructuring and if the same restructuring needs to happen at parent level then we will take similar write locks recursively up the tree. ^17a3ff

Now there is a glaring problem with pessimistic locking, even if the restructuring is limited to the leaf node and its direct parent or neighbours only then also we are taking a write latch on the root *restricting potential read operations resulting in slow reads*

## 8.0 Solution
Introduction to SX Lock (Write lock is called X lock - Exclusive lock | Read lock is called S lock - Shared lock)
> 	- SX LOCK does not conflict with S LOCK but does conflict with X LOCK. SX Locks also conflict with each other. 
> 	- The purpose of an SX LOCK is to indicate the intention to modify the protected area, but the modification has not yet started. Therefore, the resource is still accessible, but once the modification begins, access will no longer be allowed. Since an intention to modify exists, no other modifications can occur, so it conflicts with X LOCKs.

SX locks are kind of like X lock among themselves but are like S locks when used with S locks, Now with SX locks are held in following manner.
- READ OPERATION: We take S lock as before on the root node, but we also take S locks on the internal nodes till the leaf nodes
- WRITE OPERATION: If the write operation is just going to modify the leaf page we still use Optimistic Locking [[#^ab3c53]]
  But if the write operation involves restructuring of the tree then instead of taking a write lock on the root as discussed in Pessimistic locking [[#^17a3ff]] We take SX lock on the root and same X locks on leaf node and its direct parent and neighbour, This still allows S locks to be taken in root node to allow other read operation which are not having the same path as the ongoing write operation But still prevents another SX lock on root node by some other write operation.
  ![Pasted image 20241117130244.png](/media/pasted-image-20241117130244.png)

So we can see that SX lock's introduction helps in increasing the read throughput but still has the problem of global contention on write operation even if the writes are not going to happen in the ongoing another write operation. 
I think a root level latch is under the pessimistic guess of modification of write bubbling up to root which can conflict with another write operation even if not in the same path as bubbling up to the root will impact all the branches, butt the question is do all write operations bubble up to root and if not is it wise to take a root level of SX lock also to prevent other write operations. 
The answer lies in another type of lock mechanism called Latch Coupling or Latch Crabbing.

# References

[Inno DB B-Tree Latch Optimisation](https://baotiao.github.io/2024/06/09/english-btree.html)
