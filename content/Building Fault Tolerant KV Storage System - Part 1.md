---
title: Building Fault Tolerant KV Storage System - Part 1
draft: false
tags:
  - "#Replication"
  - "#Leader-Election"
type: post
date: 2025-10-03T20:38:34+0530
category: Distributed Systems
---

This blog post is part of a series detailing my implementation of a fault-tolerant key-value server using the RAFT consensus protocol.
Before diving into RAFT and its mechanics, it's crucial to grasp the concept of a replicated state machine and its significance in building systems that are both fault-tolerant and highly available.

## Replicated State Machine
A replicated state machine is essentially a collection of identical machines working together. One machine acts as the "master," handling client requests and dictating the system's operations. The other machines, the "replicas," diligently copy the master's _state_. This "state" encompasses all the data necessary for the system to function correctly, remembering the effects of previous operations. Think of a key-value store: the _state_ would be the key-value pairs themselves, replicated across all machines to maintain consistency and resilience.
Having the master's state copied across multiple machines enables us to use these replicas in several ways. They can take over as the new master if the original fails, or handle read operations to reduce the load on the master. Because the state is copied across machines, network issues like latency, packet loss, and packet reordering significantly affect how closely a replica's state matches the master's. The difference between the master's (most up-to-date) state and a replica's state is known as replication lag. Generally, we aim to minimize this lag, and different systems offer varying levels of consistency (which we will discuss later when covering replication in RAFT).

> Aside from application-level replication, which primarily requires context of the state needed for replication or enforces a set of rules for the state that can be replicated, another approach involves replicating the entire machine state at the instruction level. This includes replicating instruction outputs and interrupt behaviour.  This method ensures that machines execute the same set and order of instructions and maintain identical memory pages, resulting in an exact replica of the entire machine. However, this approach is more challenging to control, as managing interrupts, I/O, and replicating them to other machines is complex. An example of such an approach is discussed in [The Design of a Practical System for Fault-Tolerant Virtual Machines](https://pdos.csail.mit.edu/6.824/papers/vm-ft.pdf)_. This paper details the approach they followed when designing a hypervisor to capture and replicate the state of guest machines.

## RAFT - A Consensus Algorithm
![Pasted image 20251001155927.png](/media/pasted-image-20251001155927.png)
RAFT is a consensus algorithm for managing a replicated log. Consensus algorithms allow a collection of machines to work as a group that can survive failures of some of its members. A replicated state is generally maintained as a replicated log. Each server maintains its own copy of logs, and keeping the replicated log consistent is the job of the consensus algorithm.

Let's take an example of an operation done on a key-value store.
A client sends a command like `PUT x=2`, which is received by the master server of the group. The consensus module of the server receives this command and appends it to its log.
The master's consensus module communicates with other servers about this new log and ensures that each server's log contains the same command in the same order.
Once commands are replicated, each server processes the command on its own state machine, and since the log is the same on each server, the final state on each server results in the same output. As a result, the servers appear to form a single, highly reliable state machine.

RAFT implements this consensus between all servers by electing a leader and giving it the responsibility to decide the sequence of log operation that will be appended and propagated to each member. Flow of logs only happen in one direction from leader to other servers so if a particular server's sequence does not match to leader's sequence of logs, leader can instruct the follower (replica) server to erase its log and strictly follow leader itself.

> **From the RAFT paper:**
> Given the leader approach, Raft decomposes the consensus problem into three relatively independent subproblems, which are discussed in the subsections that follow:
> - Leader election: a new leader must be chosen when an existing leader fails.
> - Log replication: the leader must accept log entries from clients and replicate them across the cluster, forcing the other logs to agree with its own.
> - Safety: if any server has applied a particular log entry to its state machine, then no other server may apply a different command for the same log index.

### Logs, State Lifecycle and RPCs
Each `LogEntry` consists of the command it contains and the term value.
![Pasted image 20251003142917.png](/media/pasted-image-20251003142917.png)
```golang
type LogEntry struct {
	Command interface{}
	Term    int
}
```
Raft divides time into terms of arbitrary length. `Terms` are numbered with consecutive integers. Each term begins with an election, in which one or more candidates attempt to become leader.

Each server has a role, with only one designated as the Leader for a specific period. The remaining servers are either Followers, who heed the Leader's communications, or Candidates. Candidates solicit votes from other servers if they haven't received communication from a Leader within a set timeframe.
```golang
const (
	StateFollower ServerState = iota
	StateLeader
	StateCandidate
)
```

Due to variations in timing, different servers might see the changes between terms at different moments. A server might also miss an election or even entire terms. *In Raft, terms serve as a logical clock, enabling servers to identify outdated information like old leaders.* Every server keeps track of a current term number, which consistently increases. Servers exchange current terms during communication; if one server has a smaller term than another, it updates to the larger term. *Should a candidate or leader find its term is outdated, it immediately becomes a follower.* *A server will reject any request that includes an old term number.*

The diagram below illustrates how a server's role changes under different circumstances.
![Pasted image 20251002154539.png](/media/pasted-image-20251002154539.png)
To grasp the role of elections and how `Term` serves as a time marker in RAFT, we must first understand 
- How the threshold time is determined, after which a follower can become a candidate and start an election.
- How each server of the cluster communicates with one another 

Imagine a cluster of three servers experiencing a network partition, where server 0, the current leader, cannot communicate with servers 1 and 2. If the servers have a fixed timeout value for election, multiple servers might initiate elections simultaneously, resulting in no majority each time, with each server only receiving its own vote. Consequently, the cluster cannot decide on a leader for the next term. With each re-election, a server's term value (also known as `currentTerm`) increases by 1. So, when the previous server 0, from, say, term 1, rejoins the cluster after recovery, it will vote for either server 1 or 2, as both are requesting votes for their own `currentTerm` value, which will now be N if N elections have occurred after server 0 went down, with each server starting its own election and failing to become leader due to the lack of a majority. Even if server 0 votes for one server and a majority is achieved, the new leader needs to communicate with all peers, and if that doesn't happen quickly, we'll see another election. Overall, the cluster will be unstable and unable to progress due to election instability.

To resolve this, we introduce a small element of randomness to each server's election timeout. This minimizes the chance of multiple servers starting elections simultaneously and maximizes the likelihood of a single server triggering a re-election and continuing as leader for subsequent terms.

```golang
func Make(peers []*labrpc.ClientEnd, me int,
	persister *tester.Persister, applyCh chan raftapi.ApplyMsg) raftapi.Raft {
	...
	// other state initialisation, we will see them later
	...
	
	rf.electionTimeout = time.Duration(1500+(rand.Int63()%1500)) * time.Millisecond
	go rf.ticker()
	...
	// other state initialisation, we will see them later
	...
	
	}
	
func (rf *Raft) ticker() {
	for !rf.killed() {
		rf.mu.Lock()
		if rf.state != StateLeader && time.Since(rf.lastContactFromLeader) >= rf.electionTimeout {
			go rf.startElection()
		}
		rf.mu.Unlock()

		// pause for a random amount of time between 50 and 350
		// milliseconds.
		heartbeatMS := 50 + (rand.Int63() % 300) // [50, 350)ms time range
		time.Sleep(time.Duration(heartbeatMS) * time.Millisecond)
	}
}
```

Each RAFT server's state (We will discuss each state in detail later on):
```golang
type Raft struct {
	mu        sync.Mutex          // Lock to protect shared access to this peer's state
	peers     []*labrpc.ClientEnd // RPC end points of all peers
	persister *tester.Persister   // Object to hold this peer's persisted state
	me        int                 // this peer's index into peers[]
	dead      int32               // set by Kill()

	// Persisted State
	currentTerm          int        // latest term server has seen
	votedFor             int        // candidateId that received vote in current term
	log                  []LogEntry // log entries; each entry contains command for state machine, and term when entry was received by leader
	snapshotLastLogIndex int
	snapshotLastLogTerm  int
	// snapshot             []byte

	// Volatile state
	commitIndex           int                   // index of highest log entry known to be committed
	lastApplied           int                   // index of highest log entry applied to state machine
	state                 ServerState           // role of this server
	lastContactFromLeader time.Time             // Last timestamp at which leader sent heartbeat to current server
	electionTimeout       time.Duration         // time duration since last recieved heartbeat after which election will be trigerred by this server
	applyCh               chan raftapi.ApplyMsg // Channel where a raft server sends it commands to be applied to state machine

	// Volatile leader state
	nextIndex  []int      //	for each server, index of the next log entry to send to that server
	matchIndex []int      //	for each server, index of highest log entry known to be replicated on server
	applyCond  *sync.Cond // Condition validable to signal applier channel to send commands to apply channel

	leaderCancelFunc context.CancelFunc // Go context for a leader, called when we need to cancel leader's context and leader is stepping down
	replicatorCond   *sync.Cond         // Leader's conditon variable to signal replicator threads for each peer to either send heartbeat or new logs to each peer
}
```

For the communication between servers, RAFT consensus algorithm uses RPC for
- Requesting vote from other peers - `RequestVote` RPC
- Propagate changes to log entries from leader to followers - `AppendEntries` RPC
- Sending heartbeats from leader to follower - `AppendEntries` RPC with empty log data 
***RPC, or Remote Procedure Call***, is a programming paradigm that allows a program to execute a procedure (function, method) on a different machine as if it were a local procedure call.  Essentially, it's a way to build distributed systems where one program (the client) can request a service from another program (the server) over a network.
Go provides `net/rpc` package which abstract most of the work related to serialization of RPC arguments and deserialization at receiving end and the underlying network call with provided data, to know more check Go's [`net/rpc` package](https://pkg.go.dev/net/rpc)

RPC arguments and reply structs as also shown in the original paper [(page 4, fig 2)](https://pdos.csail.mit.edu/6.824/papers/raft-extended.pdf)
```golang
type RequestVoteArgs struct {
	Term         int // candidate’s term
	CandidateId  int // candidate requesting vote
	LastLogIndex int // index of candidate’s last log entry
	LastLogTerm  int // term of candidate’s last log entry
}

type RequestVoteReply struct {
	Term        int  //currentTerm, for candidate to update itself in case someone else is leader now
	VoteGranted bool // true means candidate received vote
}

// Invoked by leader to replicate log entries; also used as heartbeat.
type AppendEntriesArgs struct {
	Term         int        // leader’s term
	LeaderId     int        // so follower can redirect clients
	PrevLogIndex int        // index of log entry immediately preceding new ones
	PrevLogTerm  int        // term of prevLogIndex entry
	Entries      []LogEntry // log entries to store (empty for heartbeat; may send more than one for efficiency)
	LeaderCommit int        // leader’s commitIndex
}

type AppendEntriesReply struct {
	Term          int  // currentTerm, for leader to update itself
	Success       bool // true if follower contained entry matching prevLogIndex and prevLogTerm
	ConflictIndex int  // Followers index which is conflicting with leader's prevLogIndex
	ConflictTerm  int  // Followers term of conflicting log
}

type InstallSnapshotArgs struct {
	Term              int
	LeaderId          int
	LastIncludedIndex int
	LastIncludedTerm  int
	Data              []byte
}
```

### Rules Of Election
As we have already seen, an election timeout triggers an election by a given server, which is a `Follower`. This timeout occurs when the `Follower` does not receive any `AppendEntries` RPCs (even empty ones, containing no log) from the leader. When an election is initiated with `rf.startElection()`, the follower increments its `currentTerm` by 1 and issues `RequestVote` RPCs to each of its peers in parallel, awaiting their responses. At this point, three outcomes are possible:
- The Follower gains a majority and becomes the leader. 
  In this case, the Follower converts to the Leader state, and `setupLeader` method sets up  `rf.replicate` go routine for each of the other peers in a separate go routine. These go routines are responsible for sending heartbeats and logs using `AppendEntries` RPC calls, We use condition variable `replicatorCond` to signal these waiting go threads either when new log entry comes up or when heartbeat timeout occurs.
- While waiting for votes, a candidate may receive an `AppendEntries` RPC from another server claiming to be the leader. ***If the leader’s term (included in its RPC) is at least as large as the candidate’s current term, then the candidate recognizes the leader as legitimate and of newer term hence reverts to the follower state. If the term in the RPC is smaller than the candidate’s current term, the candidate rejects the RPC and remains in the candidate state.***
- A candidate neither wins nor loses the election. If many followers become candidates simultaneously, votes could be split, preventing any single candidate from obtaining a majority. When this happens, each candidate will time out and start a new election by incrementing its term and initiating another round of `RequestVote` RPCs. *The randomness in the election timeout helps prevent split votes from happening indefinitely.*

According to the current rules, a server receiving a `RequestVote` RPC with a `Term` greater than its own should grant its vote. However, this could lead to an outdated server with an incomplete log becoming leader. Since the leader is responsible for log propagation and can overwrite follower logs, it's possible for such an outdated leader to erase already committed logs for which clients have received responses - an undesirable outcome.
Re-examining the `RequestVoteArgs` reveals that, in addition to `Term`, the struct includes `LastLogIndex` and `LastLogTerm`, representing the candidate's last log entry's index and term, respectively. These values help determine if the candidate's log contains at least the latest committed entries. The rules for verifying this when voting are straightforward:
Raft determines the more up-to-date of two logs by comparing the index and term of their last entries. If the last entries have different terms, the log with the latter term is considered more up-to-date. If the logs share the same last term, the longer log is deemed more up-to-date.

Let's understand how RAFT prevents a stale server from winning an election and becoming a leader with the help of an example:
consider a follower **A** that gets partitioned away from the rest of the cluster. Its election timeout fires, so it increments its term and starts an election by sending `RequestVote` RPCs. Since it cannot reach the majority, it doesn’t become leader.
Meanwhile, the rest of the cluster still has a leader **B**. Because **B** can talk to a majority of servers, it continues to accept new log entries, replicate them, and safely commit them. Remember: in Raft, an entry is considered _committed_ only after it is stored on a majority of servers.
Later, when connectivity is restored, server **A** now has a higher term than **B**. This causes **A** to reject `AppendEntries` from **B**, forcing **B** to step down. At this moment, no leader exists until a new election is held.
Here’s where Raft’s rules keep the system safe:
- **A cannot win leadership election** because its log is missing committed entries that the majority already agreed on. Other servers will refuse to vote for it by comparing their latest log index and term with `RequestVote` RPC Arg's `LastLogIndex` and `LastLogTerm`.
- A new leader must have logs that are at least as up-to-date as the majority. This ensures that committed entries are never lost.
- Once a new leader is elected, it brings **A** back in sync by replicating the missing committed entries.
This scenario highlights how Raft’s election rules preserve correctness: even if a partitioned follower returns with a higher term, it cannot override the majority’s progress. Leadership always ends up with a server that reflects all committed entries, and the cluster converges to the same state.
In upcoming parts, we’ll dive deeper into Raft’s log replication process and how **heartbeats** help keep leaders and followers synchronized.
Given below is the implementation for `RequestVote` which highlights all the restrictions and responses for various election restrictions.

```golang
func (rf *Raft) RequestVote(args *RequestVoteArgs, reply *RequestVoteReply) {
	rf.mu.Lock()
	defer rf.mu.Unlock()

	fmt.Printf("[Peer: %d | RequestVote]: Candidate %d seeking vote for term: %d.\n", rf.me, args.CandidateId, args.Term)

	// Election voting restrictions for follower
	// - Candidate's term is older than follower from whom it is seeking vote
	// - Follower already voted
	// - Candidate's log is older then the follower
	// In all the above cases follower will not vote for the candidate and respond back with its current term
	// for the candidate to roll back to follower
	isCandidateOfOlderTerm := args.Term < rf.currentTerm

	if isCandidateOfOlderTerm {
		reply.Term = rf.currentTerm
		reply.VoteGranted = false

		fmt.Printf("[Peer: %d | RequestVote]: Candidate %d is of older term. Candidate's term: %d | My current term %d\n", rf.me, args.CandidateId, args.Term, rf.currentTerm)

		return
	} else {
		fmt.Printf("[Peer: %d | RequestVote]: Candidate %d is of newer or equal term. Candidate's term: %d | My current term %d\n", rf.me, args.CandidateId, args.Term, rf.currentTerm)

		if args.Term > rf.currentTerm {
			if rf.state == StateLeader {
				fmt.Printf("[Peer: %d | RequestVote]: Recieved vote request from candiate of higher term, winding up my own leadership setup.\n", rf.me)
				if rf.leaderCancelFunc != nil {
					rf.leaderCancelFunc()
					rf.replicatorCond.Broadcast()
				}
			}

			rf.currentTerm = args.Term
			rf.state = StateFollower
			rf.votedFor = -1

			rf.persist(nil)
		}

		canVote := rf.votedFor == -1 || rf.votedFor == args.CandidateId
		var currentLatestLogTerm int
		currentLatestLogIndex := len(rf.log) - 1

		if currentLatestLogIndex > 0 {
			currentLatestLogTerm = rf.log[currentLatestLogIndex].Term
		} else if rf.snapshotLastLogIndex > 0 {
			currentLatestLogTerm = rf.snapshotLastLogTerm
		}

		currentLatestLogIndex += rf.snapshotLastLogIndex

		isCandidateLogOlder := args.LastLogTerm < currentLatestLogTerm || (args.LastLogTerm == currentLatestLogTerm && args.LastLogIndex < currentLatestLogIndex)

		if canVote && !isCandidateLogOlder {
			fmt.Printf("[Peer: %d | RequestVote]: Granted vote for term: %d, To candidate %d.\n", rf.me, args.Term, args.CandidateId)
			rf.votedFor = args.CandidateId
			rf.lastContactFromLeader = time.Now()

			reply.VoteGranted = true
			rf.persist(nil)
		} else {
			fmt.Printf("[Peer: %d | RequestVote]: Candidate %d log is older than mine. Log(index/term): Candidate's: (%d, %d) | Mine: (%d, %d).\n", rf.me, args.CandidateId, args.LastLogIndex, args.LastLogTerm, currentLatestLogIndex, currentLatestLogTerm)
			reply.VoteGranted = false
		}

		reply.Term = rf.currentTerm
	}
}
```

Here are some things to keep in mind when implementing the `RequestVote` RPC:
- Note the use of `snapshotLastLogIndex` and `snapshotLastLogTerm`, which relate to log compaction. Think of a snapshot as capturing the current state machine's image, allowing us to shorten logs up to that point, reducing overall log size. We'll explore how this works and its benefits later. For now, understand that a server, when verifying if a candidate has current logs, needs to read its own. If the log is truncated shortly after a snapshot, we store the snapshot's last details, like the index and term of the log at that index. Snapshotting generally shortens the log, but because indexes always increase, we use `snapshotLastLogIndex` as an offset to get the right index.
- When a candidate gets a majority, it calls `setupLeader`, creating a context that can be cancelled, using Go's context package. This context returns a function, `leaderCancelFunc`, which, when called, cancels the context. We do this when a leader steps down, such as when it receives a `RequestVote` RPC from a candidate with a higher term. In this case, we cancel the leader's context. This is useful when the leader is performing async operations (like sending heartbeats or logs) and waiting for them. We then wait for the operation to complete or the context to be cancelled, signalling that we no longer need to wait because the current server is no longer the leader. We'll see what happens when a leader's context is cancelled later.
- A potentially confusing aspect is that when we receive a `RequestVote` RPC response denying the vote and containing a **Term greater than our current one**, we examine the candidate's current state. This state might no longer be "candidate" because the `RequestVote` RPC could be delayed, and the node might have already gained a majority and become the leader. Despite any RPC delays, we strictly adhere to a core Raft principle: *upon receiving an RPC response with a Term greater than our current Term, we immediately update our Term to match the response. If we are the leader, we step down.* This rule is crucial because the **Term serves as a time indicator for the entire Raft cluster. Discovering that time has progressed requires us to adapt accordingly.**

So to summarize:
When a follower receives a `RequestVote`, it rejects the request if:
1. The candidate’s term is smaller (`args.Term < rf.currentTerm`).
2. It has already voted for another candidate in this term (`rf.votedFor != -1 && rf.votedFor != args.CandidateId`).
3. The candidate’s log is less up-to-date than its own, according to Raft’s freshness rule:
   Candidate’s last log term must be greater, or equal with a log index at least as large.


We have already seen how `ticker` calls `startElection` method based on election timeout, Let's now understand with given below implementation of `startElection`, How a candidate asks for votes and what are the edge cases to consider while waiting for `RequestVote` RPC responses 
```golang
func (rf *Raft) startElection() {
	rf.mu.Lock()

	// Tigger election, send RequestVote RPC
	// Once you have voted for someone in a term the elction timeout should be reset
	// Reset election timer for self
	rf.lastContactFromLeader = time.Now()

	// Reset the election timeout with new value
	rf.electionTimeout = time.Duration(1500+(rand.Int63()%1500)) * time.Millisecond
	rf.currentTerm += 1 // increase term
	rf.state = StateCandidate
	peerCount := len(rf.peers)

	voteCount := 1 // self vote
	lastLogIndex := len(rf.log) - 1
	var lastLogTerm int

	done := make(chan struct{})

	if lastLogIndex > 0 {
		lastLogTerm = rf.log[lastLogIndex].Term
	} else if rf.snapshotLastLogIndex > 0 {
		lastLogTerm = rf.snapshotLastLogTerm
	}

	lastLogIndex += rf.snapshotLastLogIndex

	rf.persist(nil)

	fmt.Printf("[Candidate: %d | Election Ticker]: Election timout! Initiating election for term %d, with lastLogIndex: %d & lastLogTerm: %d.\n", rf.me, rf.currentTerm, lastLogIndex, lastLogTerm)
	fmt.Printf("[Candidate: %d | Election Ticker]: Election timeout reset to: %v.\n", rf.me, rf.electionTimeout)

	args := &RequestVoteArgs{
		Term:         rf.currentTerm,
		CandidateId:  rf.me,
		LastLogIndex: lastLogIndex,
		LastLogTerm:  lastLogTerm,
	}
	requestVoteResponses := make(chan *RequestVoteReply)

	for peerIndex, peer := range rf.peers {
		if peerIndex != rf.me {
			go func(peer *labrpc.ClientEnd) {
				select {
				case <-done:
					// Either majority is achieved or candidate is stepping down as candidate
					// Dont wait for this peer's RequestVote RPC response and exit this goroutine
					// to prevent goroutine leak
					return
				default:
					reply := &RequestVoteReply{}
					fmt.Printf("[Candidate: %d | Election Ticker]: Requesting vote from peer: %d.\n", rf.me, peerIndex)
					ok := peer.Call("Raft.RequestVote", args, reply)
					if ok {
						select {
						case requestVoteResponses <- reply:
						case <-done:
							return
						}
					}
				}
			}(peer)
		}
	}

	// Releasing the lock after making RPC calls
	// Each RPC call for RequestVote is in its own thread so its not blocking
	// We can release the lock after spawning RequestVote RPC thread for each peer
	// Before releasing the lock lets make copy of some state to verify sanity
	// After reacquiring the lock
	electionTerm := rf.currentTerm
	rf.mu.Unlock()

	majority := peerCount/2 + 1

	for i := 0; i < peerCount-1; i++ {
		select {
		case res := <-requestVoteResponses:
			if rf.killed() {
				fmt.Printf("[Candidate: %d | Election Ticker]: Candidate killed while waiting for peer RequestVote response. Aborting election process.\n", rf.me)
				close(done) // Signal all other RequestVote goroutines to stop
				return
			}

			rf.mu.Lock()

			// State stale after RequestVote RPC
			if rf.currentTerm != electionTerm || rf.state != StateCandidate {
				rf.mu.Unlock()
				close(done)
				return
			}

			if res.Term > rf.currentTerm {
				// A follower voted for someone else
				// If they voted for same term then we can ignore
				// But if term number is higher than our current term then
				// we should step from candidate to follower and update our term as well
				fmt.Printf("[Candidate: %d | Election Ticker]: Stepping down as Candidate, Recieved RequestVoteReply with term value %d > %d - my currentTerm.\n", rf.me, res.Term, rf.currentTerm)

				rf.currentTerm = res.Term
				rf.state = StateFollower
				rf.mu.Unlock()

				rf.persist(nil)
				close(done)
				return
			}

			if res.VoteGranted {
				voteCount++
				if voteCount >= majority {
					// Won election
					fmt.Printf("[Candidate: %d | Election Ticker]: Election won with %d/%d majority! New Leader:%d.\n", rf.me, voteCount, peerCount, rf.me)
					rf.state = StateLeader

					rf.mu.Unlock()
					close(done)

					rf.setupLeader()
					return
				}
			}

			rf.mu.Unlock()

		case <-time.After(rf.electionTimeout):
			rf.mu.Lock()
			fmt.Printf("[Candidate: %d | Election Ticker]: Election timeout! Wrapping up election for term: %d. Got %d votes. Current state = %d. Current set term: %d.\n", rf.me, electionTerm, voteCount, rf.state, rf.currentTerm)
			rf.mu.Unlock()

			close(done)
			return
		}

	}
}
```

Within `startElection`, we construct `RequestVoteArgs` and concurrently dispatch the RPC to every peer using separate goroutines for each call. A `done` channel is also provided to these goroutines to signal events such as:
- Election cancellation, occurring if the Candidate reverts to Follower status, potentially after sending initial `RequestVote` RPCs upon receiving a heartbeat OR a `RequestVote` RPC from another peer whose Term is at least the Candidate's current Term.
- Cancellation of waiting for `RequestVote` RPC responses if a majority has been secured or the election timeout is reached.
- It's worth noting that after sending RPC calls to each peer, *we release the lock*. This prevents us from blocking other incoming messages to that peer while awaiting RPC responses. This is why we use the `done` Go channel. It ensures that any concurrent request from elsewhere that modifies the candidate's status is notified. This happens when the `done` channel is closed, causing the `case <-done:` statement to return first in the `select` block.

[6.5840 Labs](https://pdos.csail.mit.edu/6.824/labs/lab-raft1.html) provide us with following test cases for leader election:
```sh
❯ go test -run 3A
Test (3A): initial election (reliable network)...
  ... Passed --  time  5.5s #peers 3 #RPCs    36 #Ops    0
Test (3A): election after network failure (reliable network)...
  ... Passed --  time  8.4s #peers 3 #RPCs    50 #Ops    0
Test (3A): multiple elections (reliable network)...
  ... Passed --  time 16.9s #peers 7 #RPCs   382 #Ops    0
PASS
ok      6.5840/raft1    31.352s
```

## Conclusion

In this part we understood how RAFT manages a replicated log across a cluster of machines, ensuring consistency and availability. The post details the roles of leader, follower, and candidate, along with the key concepts of terms, log entries, leader election, and log replication. Crucial mechanisms, such as checks on `RequestVote` and `AppendEntries` RPCs and random timeouts, guarantee leader accuracy and prevent split votes. The post lays the groundwork for understanding how RAFT ensures that committed log entries are never lost and how a valid leader is reliably elected. 

In subsequent parts, we will see how we set up a leader when a candidate wins election and how we handle leader stepping down from leadership. Then we will see how log replication actually happens along with cases of log conflicts and log corrections by leader and how heartbeats helps to achieve that, In the end we will trace a client request to see the behaviour of this distributed cluster seen as a single machine from client's point of view.

# References

- https://pdos.csail.mit.edu/6.824/papers/raft-extended.pdf
- Leader Election[ Visualization]( https://thesecretlivesofdata.com/raft/#election)
- https://thesquareplanet.com/blog/students-guide-to-raft/