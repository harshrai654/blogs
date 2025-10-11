---
title: Building Fault Tolerant KV Storage System - Part 2
draft: true
tags:
  - "#Replication"
  - "#Leader-Election"
  - RAFT
type: post
date: 2025-10-04T16:16:17+0530
category: Distributed Systems
---
%% Explain sequence:
- Concept of commit Index, lastApplied Index in RAFT state
- Explain setupLeader, lastContactFromLeader - how it helps in preventing election.
- A egenral flow of request from client with Start continuing with
- ~~replicate method introduces in setpLeader and how CV helps in signalling for heartbeat or logs~~
- ~~How AppendEntries as a single RPC does the jobs of both heartbeat and log replication~~
- ~~How leader maintains next and match index and what does that mean~~
- Explain everything about replicate and AppendEntries RPC
- How Log correction happen `reconileLogs`  and how we use optimisation there to reduce RPC trips
- Explain how applier runs on different thtread why it runs on different thread and how CV help their %%

We [previously discussed]({{< relref "Building Fault Tolerant KV Storage System - Part 1.md" >}}) replicated state machines, leader election in the RAFT consensus algorithm, and log-based state maintenance. Now, we'll focus on log replication across peer servers. We'll also examine how RAFT ensures that the same commands are applied to the state machine at a given log index on every peer, because of the leader's one-way log distribution to followers.

## Leader Initialisation
Once a candidate becomes leader we call `setupLeader` function which initiates go routine for each peer in the RAFT cluster, Each go routine of respective peer is responsible for replicating new log entries or sending heartbeat via `AppendEntries`  RPC.
```golang
func (rf *Raft) setupLeader() {
	rf.mu.Lock()
	defer rf.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	rf.leaderCancelFunc = cancel

	for peerIndex := range rf.peers {
		if peerIndex != rf.me {
			rf.nextIndex[peerIndex] = len(rf.log) + rf.snapshotLastLogIndex
			go rf.replicate(peerIndex, ctx)
		}
	}

	go func() {
		for !rf.killed() {
			select {
			case <-ctx.Done():
				return
			case <-time.After(HEARTBEAT_TIMEOUT):
				rf.replicatorCond.Broadcast()
			}
		}
	}()
}
```

When starting a replication logic thread for each peer, we also send a Go context to `rf.replicate`. This context shows the current leader's status. If the leader steps down, we call `rf.leaderCancelFunc`, which cancels the context. When a context is canceled, the `ctx.Done()` channel closes, stopping any waiting for results from that channel. More information about Go's context can be found [here](https://pkg.go.dev/context).
Our RAFT struct includes a condition variable, `replicatorCond` (of type `*sync.Cond`), that signals all peer goroutines of the leader to run the replication logic every `HEARTBEAT_TIMEOUT`. This ensures that a heartbeat is sent to each peer at the specified interval.
A condition variable provides functions like `Wait`, `Signal`, and `Broadcast`. If multiple threads are waiting on a condition variable after releasing the underlying mutex, `Signal` will wake one of such waiting threads, and `Broadcast` will wake all waiting threads. Here we are using `Broadcast` to wake all waiting threads of each peer to send the next heartbeat. A condition variable is an operating system concept, and you can read more about the same from [here](https://pages.cs.wisc.edu/~remzi/OSTEP/threads-cv.pdf). To read about the API of Go's of type `*sync.Cond`, check Go's official Docs [here](https://pkg.go.dev/sync#Cond).

## Log Replication
Each individual peer thread runs the replicate method, given below is implementation of `rf.replicate` function

```golang
func (rf *Raft) replicate(peerIndex int, ctx context.Context) {
	logMismatch := false
	for !rf.killed() {
		select {
		case <-ctx.Done():
			dprintf("[leader-replicate: %d | peer: %d]: Leader stepped down from leadership before initiating replicate.\n", rf.me, peerIndex)
			return
		default:
			rf.mu.Lock()

			if rf.state != StateLeader {
				dprintf("[leader-replicate: %d | peer: %d]: Not a leader anymore, winding up my leadership setup.\n", rf.me, peerIndex)
				if rf.leaderCancelFunc != nil {
					rf.leaderCancelFunc()
					rf.replicatorCond.Broadcast()
				}
				rf.mu.Unlock()
				return
			}

			// Only waiting when:
			// - There is no log to send - In this case the wait will be signalled by the heartbeat
			// - We are in a continuous loop to find correct nextIndex for this peer with retrial RPCs
			if !logMismatch && rf.nextIndex[peerIndex] >= len(rf.log)+rf.snapshotLastLogIndex {
				dprintf("[leader-replicate: %d | peer: %d]: Wating for next signal to replicate.\n", rf.me, peerIndex)
				rf.replicatorCond.Wait()
			}

			if rf.killed() {
				return
			}

			reply := &AppendEntriesReply{}
			logStartIndex := rf.nextIndex[peerIndex]
			var prevLogTerm int
			prevLogIndex := logStartIndex - 1
			peer := rf.peers[peerIndex]

			if prevLogIndex-rf.snapshotLastLogIndex > 0 {
				prevLogTerm = rf.log[prevLogIndex-rf.snapshotLastLogIndex].Term
			} else if prevLogIndex == rf.snapshotLastLogIndex {
				prevLogTerm = rf.snapshotLastLogTerm
			} else {
				// prevLogIndex < rf.snapshotLastLogIndex
				prevLogTerm = -1
			}

			if prevLogTerm == -1 {
				logMismatch = true
				// Leader does not have logs at `prevLogIndex` because of compaction
				// Leader needs to send snaphot to the peer as part of log repairing
				args := &InstallSnapshotArgs{
					Term:              rf.currentTerm,
					LeaderId:          rf.me,
					LastIncludedIndex: rf.snapshotLastLogIndex,
					LastIncludedTerm:  rf.snapshotLastLogTerm,
					Data:              rf.persister.ReadSnapshot(),
				}

				reply := &InstallSnapshotReply{}

				dprintf("[leader-install-snapshot: %d: peer: %d]: InstallSnapshot RPC with index: %d and term: %d sent.\n", rf.me, peerIndex, args.LastIncludedIndex, args.LastIncludedTerm)
				rf.mu.Unlock()

				ok := rf.sendRPCWithTimeout(ctx, peer, peerIndex, "InstallSnapshot", args, reply)

				rf.mu.Lock()

				if ok {
					if reply.Term > rf.currentTerm {
						dprintf("[leader-install-snapshot: %d: peer: %d]: Stepping down from leadership, Received InstallSnapshot reply from peer %d, with term %d > %d - my term\n", rf.me, peerIndex, peerIndex, reply.Term, rf.currentTerm)

						rf.state = StateFollower
						rf.currentTerm = reply.Term
						rf.lastContactFromLeader = time.Now()

						if rf.leaderCancelFunc != nil {
							rf.leaderCancelFunc()
							rf.replicatorCond.Broadcast()
						}
						rf.persist(nil)
						rf.mu.Unlock()
						return
					}

					dprintf("[leader-install-snapshot: %d: peer: %d]: Snapshot installed successfully\n", rf.me, peerIndex)
					rf.nextIndex[peerIndex] = rf.snapshotLastLogIndex + 1
					rf.mu.Unlock()
					continue
				} else {
					dprintf("[leader-install-snapshot: %d: peer: %d]: Snapshot installtion failed!\n", rf.me, peerIndex)
					rf.nextIndex[peerIndex] = rf.snapshotLastLogIndex
					rf.mu.Unlock()
					continue
				}
			} else {
				replicateTerm := rf.currentTerm

				logEndIndex := len(rf.log) + rf.snapshotLastLogIndex
				nLogs := logEndIndex - logStartIndex

				args := &AppendEntriesArgs{
					Term:         rf.currentTerm,
					LeaderId:     rf.me,
					PrevLogIndex: prevLogIndex,
					PrevLogTerm:  prevLogTerm,
					LeaderCommit: rf.commitIndex,
				}

				if nLogs > 0 {
					entriesToSend := rf.log[logStartIndex-rf.snapshotLastLogIndex:]
					args.Entries = make([]LogEntry, len(entriesToSend))
					copy(args.Entries, entriesToSend)
					dprintf("[leader-replicate: %d | peer: %d]: Sending AppendEntries RPC in term %d with log index range [%d, %d).\n", rf.me, peerIndex, replicateTerm, logStartIndex, logEndIndex)
				} else {
					dprintf("[leader-replicate: %d | peer: %d]: Sending AppendEntries Heartbeat RPC for term %d.\n", rf.me, peerIndex, replicateTerm)
				}

				rf.mu.Unlock()
				ok := rf.sendRPCWithTimeout(ctx, peer, peerIndex, "AppendEntries", args, reply)

				rf.mu.Lock()

				if ok {
					select {
					case <-ctx.Done():
						dprintf("[leader-replicate: %d | peer: %d]: Leader stepped down from leadership after sending AppendEntries RPC.\n", rf.me, peerIndex)
						rf.mu.Unlock()
						return
					default:
						// Check fot change in state during the RPC call
						if rf.currentTerm != replicateTerm || rf.state != StateLeader {
							// Leader already stepped down
							dprintf("[leader-replicate: %d | peer: %d]: Checked ladership state after getting AppendEntries Reply, Not a leader anymore, Winding up my leadership setup.\n", rf.me, peerIndex)
							if rf.leaderCancelFunc != nil {
								rf.leaderCancelFunc()
								rf.replicatorCond.Broadcast()
							}
							rf.mu.Unlock()
							return
						}

						// Handle Heartbeat response
						if !reply.Success {
							if reply.Term > rf.currentTerm {
								dprintf("[leader-replicate: %d: peer: %d]: Stepping down from leadership, Received ApppendEntries reply from peer %d, with term %d > %d - my term\n", rf.me, peerIndex, peerIndex, reply.Term, rf.currentTerm)

								rf.state = StateFollower
								rf.currentTerm = reply.Term
								rf.lastContactFromLeader = time.Now()

								if rf.leaderCancelFunc != nil {
									rf.leaderCancelFunc()
									rf.replicatorCond.Broadcast()
								}
								rf.persist(nil)
								rf.mu.Unlock()
								return
							}

							// Follower rejected the AppendEntries RPC beacuse of log conflict
							// Update the nextIndex for this follower
							logMismatch = true
							followersConflictTermPresent := false
							if reply.ConflictTerm != -1 {
								for i := prevLogIndex - rf.snapshotLastLogIndex; i > 0; i-- {
									if rf.log[i].Term == reply.ConflictTerm {
										rf.nextIndex[peerIndex] = i + 1 + rf.snapshotLastLogIndex
										followersConflictTermPresent = true
										break
									}

								}

								if !followersConflictTermPresent {
									rf.nextIndex[peerIndex] = reply.ConflictIndex
								}
							} else {
								rf.nextIndex[peerIndex] = reply.ConflictIndex
							}
							dprintf("[leader-replicate: %d | peer: %d]: Logmismatch - AppendEntries RPC with previous log index %d of previous log term %d failed. Retrying with log index:%d.\n", rf.me, peerIndex, prevLogIndex, prevLogTerm, rf.nextIndex[peerIndex])
							rf.mu.Unlock()
							continue
						} else {
							dprintf("[leader-replicate: %d | peer: %d]: responded success to AppendEntries RPC in term %d with log index range [%d, %d).\n", rf.me, peerIndex, replicateTerm, logStartIndex, logEndIndex)
							logMismatch = false

							if nLogs > 0 {
								// Log replication successful
								rf.nextIndex[peerIndex] = prevLogIndex + nLogs + 1
								rf.matchIndex[peerIndex] = prevLogIndex + nLogs

								// Need to track majority replication upto latest log index
								// - So that we can update commitIndex
								// - Apply logs upto commitIndex
								// Just an idea - maybe this needs to be done separately in a goroutine
								// Where we continuosly check lastApplied and commitIndex
								// Apply and lastApplied to commit index and if leader send the response to apply channel
								majority := len(rf.peers)/2 + 1

								for i := len(rf.log) - 1; i > rf.commitIndex-rf.snapshotLastLogIndex; i-- {
									matchedPeerCount := 1
									if rf.log[i].Term == rf.currentTerm {
										for pi := range rf.peers {
											if pi != rf.me && rf.matchIndex[pi] >= i+rf.snapshotLastLogIndex {
												matchedPeerCount++
											}
										}
									}

									// Largest possible log index greater the commitIndex replicated at majority of peers
									// update commitIndex
									if matchedPeerCount >= majority {
										rf.commitIndex = i + rf.snapshotLastLogIndex

										dprintf("[leader-replicate: %d | peer: %d]: Log index %d replicated to majority of peers.(%d/%d peers), updating commitIndex to : %d, current lastApplied value: %d.\n", rf.me, peerIndex, i+rf.snapshotLastLogIndex, matchedPeerCount, len(rf.peers), rf.commitIndex, rf.lastApplied)
										rf.applyCond.Signal()
										break
									}
								}
							}

							rf.mu.Unlock()
							continue
						}
					}
				}
				dprintf("[leader-replicate: %d | peer %d]: Sending AppendEntries RPC at leader's term: %d, failed. Payload prevLogIndex: %d | prevLogTerm: %d.\n", rf.me, peerIndex, replicateTerm, prevLogIndex, prevLogTerm)
				rf.mu.Unlock()
				continue
			}
		}
	}
}
```

The `replicate` function operates in a continuous loop. Inside this loop, a `select` statement monitors the leader's context (`ctx`) status. If `ctx.Done()` is not yet closed, it confirms the current server is still the leader. To ensure correctness, the server's current state is also checked to be `StateLeader`. If it's not, `rf.leaderCanelFunc` is explicitly called to relinquish leadership, which closes the context's done channel, signalling the leader's relinquishment to other components. Additionally, the loop waits on `rf.replicatorCond` when there are no more logs to transmit and no log mismatch between the leader's and the peer's logs.
As mentioned in [Part 1 of this blog series]({{< relref "Building Fault Tolerant KV Storage System - Part 1.md" >}}), servers periodically compact their logs to manage their size. This involves taking a snapshot of the current state and then truncating the log up to that point. If a follower's log is significantly behind the leader's and the leader has already truncated its log, the leader may need to send a snapshot using the `InstallSnapshot` RPC. We will delve deeper into log compaction in a later part of this series.
Leader maintains volatile state for each peer `nextIndex` and `matchIndex`, these two properties for each peer are maintained by the leader, and it tells the leader which next log index to send to the peer and index up to which logs are replicated for that peer respectively.

### Heartbeat rules
The `AppendEntries` RPC also functions as a heartbeat, allowing the leader to communicate its identity and log status to all followers. A follower only accepts this RPC if:
- The leader's `Term` value is greater than or equal to the follower's current term. If not, the follower rejects the RPC, signalling that the sender (mistakenly believing itself to be the leader) is outdated. The follower sends its own `reply.Term` to indicate this. Upon receiving a `Term` in the reply that is higher than its own, the leader relinquishes leadership.
- The leader includes `PrevLogIndex` and `PrevLogTerm` with each `AppendEntries` RPC. These values are vital, as they indicate the leader's log state by specifying the index and term of the log up to which the leader believes the follower's log matches. If there is a discrepancy, the follower responds with `reply.Success` set to false, indicating a log mismatch. The leader then decreases `nextIndex[peerIndex]` for that peer and sends another heartbeat with an earlier log index. This process continues until a matching log index is found. At that point, the follower accepts the leader's `AppendEntries` RPC and uses the `reconcileLogs` function to remove conflicting log entries and replace them with the log range sent by the leader from `[PrevLogIndex + 1, LatestLogIndexAtLeader]`. extracted from `args,Entries` field.
  This RAFT property is followed by each index of the follower, so if the current index and term match with the leader, so does the log index previous to this one, or else a conflict would have occurred previously itself. **So this single property ensures that the log state matches between leader and follower up to the latest index;** otherwise, the follower will not accept the heartbeat or normal `AppendEntries` RPC with log entries, *and the to-and-fro of heartbeats after that to find the non-conflict index at the follower is called the log correction process.* Later on, we will see how we can optimise this log correction because currently the leader needs to try for each log index in decreasing order, which can take a lot of time if the follower has been stale for a long time and during that time the leader's log has grown a lot.

![Pasted image 20251005180921.png](/media/pasted-image-20251005180921.png)
The image above, shows a simple successful log replication situation. Here, Follower 1 and Follower 2 have the same initial part of the log as the leader. Also, the leader knows exactly which parts of the log need to be sent to each follower.

In the `replicate` method, we use a `logMismatch` flag within the replication loop. This flag shows if there was a log problem when sending the `AppendEntries` RPC in the last loop. If there was a problem, we don't wait (we don't call `rf.replicatorCond.Wait()`, which releases the lock and puts the thread to sleep). This is because, if there's a log problem, we want to fix the log quickly, so we send the next `AppendEntries` RPC right away with the updated previous log index and term.
If the previous log index is less than the index up to which we've taken a snapshot of the state and shortened the log, we send an `InstallSnapshot` RPC to send the snapshot to the follower instead, since we don't have the needed logs. We'll discuss snapshots and log compaction more later.
We still follow one rule closely: if we get an RPC reply with a term value higher than the leader's current term, the leader gives up leadership by cancelling the context. See the [previous part]({{< relref "Building Fault Tolerant KV Storage System - Part 1.md" >}}) for more information.

![Pasted image 20251005233402.png](/media/pasted-image-20251005233402.png)
In the image, follower 1's `nextIndex` is at index `7`. When an `AppendEntries` RPC is sent with `prevLogIndex=6` and `prevLogTerm=2`, the follower detects a log mismatch and rejects the RPC. Because the follower's term is also `2`, the leader keeps its leadership role and immediately reduces its `nextIndex` for follower 1 to `6`. It then sends another `AppendEntries` RPC (without waiting due to `logMismatch=true`) with `prevLogIndex=5` and `prevLogTerm=2`. This second RPC is accepted. The leader sends `Entries=[1, 2]`, causing the entries after index 5 to be replaced by these new entries (handled by ). **Thus, the leader can erase uncommitted entries from the follower during log correction.**
Follower 2 accepts the initial `AppendEntries` RPC because there is no conflict. **Since The leader manages each peer in its own separate goroutine**, After each successful RPC response, the leader checks if a majority (replication factor) has replicated the log up to a specific index. In this scenario, once follower 2 responds (likely before follower 1, which is still correcting its log), the leader will have replicated log `index 7 on 2/3` of the peers (including itself). 

The leader then updates its `commitIndex` and signals a condition variable called `rf.applyCond`. First, we will examine how the follower handles the `AppendEntries` RPC.  Then, building on this understanding, we will discuss `commitIndex`, `lastApplied`, and` rf.applyCond`, explaining how they ensure log entries are committed, what "committed" means, what "applying" a log means, and how it is handled."

### Handling `AppendEntries` RPC 
- AppendEntries code and expalantion
- reconcileLogs
- lastContactFromLeader

### Committing and Applying Log Entries

``
 



# References

- https://pdos.csail.mit.edu/6.824/papers/raft-extended.pdf
- Log Replication [Visualisation](https://thesecretlivesofdata.com/raft/#replication)
- https://thesquareplanet.com/blog/students-guide-to-raft/
- https://pages.cs.wisc.edu/~remzi/OSTEP/threads-cv.pdf