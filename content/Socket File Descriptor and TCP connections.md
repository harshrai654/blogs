---
title: Socket File Descriptor and TCP connections
draft: false
tags:
  - FileSystem
  - Networking
  - OS
  - TCP
type: post
date: 2025-03-02T16:15:01+0530
category: Operating System
---


## Socket File Descriptors and Their Kernel Structures
- A **socket** is a special type of file descriptor (FD) in Linux, represented as `socket:[inode]`.
- Unlike regular file FDs, socket FDs point to **in-memory kernel structures**, not disk inodes.
- The `/proc/<pid>/fd` directory lists all FDs for a process, including sockets.
- The **inode number** of a socket can be used to inspect its details via tools like `ss` and `/proc/net/tcp`.

#### Example: Checking Open FDs for Process `216`

```
ls -l /proc/216/fd
```

**Output:**

```
lrwx------. 1 root root 64 Mar  2 09:01 0 -> /dev/pts/5
lrwx------. 1 root root 64 Mar  2 09:01 1 -> /dev/pts/5
lrwx------. 1 root root 64 Mar  2 09:01 2 -> /dev/pts/5
lrwx------. 1 root root 64 Mar  2 09:01 3 -> 'socket:[35587]'
```

- Here, FD **3** is a **socket** pointing to **inode 35587**.
#### Checking FD Details

```
cat /proc/216/fdinfo/3
```
#### Output:

```
pos:    0
flags:  02
mnt_id: 10
ino:    35587
```

---

## How Data Flows Through a Socket (User Space to Kernel Space)

- When a process writes data to a socket, it is **copied** from **user-space memory to kernel-space buffers** (using syscall `write()`).
- The kernel then processes and forwards the data to the network interface card (NIC).
- **This copying introduces overhead**, which can be mitigated using **zero-copy techniques like** `sendfile()` **and**  `io_uring`. ([A tweet which might recall this](https://x.com/AkJn99/status/1893291520029282711))

### TCP 3-Way Handshake (How a Connection is Established)

- A TCP connection is established through a **3-way handshake** between the client and server:
    
    1. **Client → SYN** (Initial sequence number)    
    2. **Server → SYN-ACK** (Acknowledges client’s SYN, sends its own)
    3. **Client → ACK** (Acknowledges server’s SYN-ACK)

#### **Checking a Listening TCP Port**

```
ss -aep | grep 35587
```

**Output:**

```
tcp   LISTEN    0      0            0.0.0.0:41555          0.0.0.0:*    users:(("nc",pid=216,fd=3)) ino:35587 sk:53f53fa7
```

- **Port 41555** is in the **LISTEN** state, bound to `nc` (netcat).
- It corresponds to socket **inode 35587**.

---

## TCP Connection Queues in the Kernel

Once a TCP connection request arrives, it goes through **two queues managed by the kernel**:
#### **1️] SYN Queue (Incomplete Connection Queue)**

- Holds **half-open connections** (received SYN but not yet fully established).
- If this queue overflows, new SYN requests may be **dropped (SYN flood attack risk)**.

#### **2]Accept Queue (Backlog Queue, Fully Established Connections)**

- Holds connections that have completed the handshake and are waiting for `accept()`.
- Controlled by `listen(sockfd, backlog)`, where **backlog** defines max queue size
- If full, new connections are **dropped**.

#### Checking Connection Queues

```
ss -ltni
```

**Output:**

```
State  Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0      5      0.0.0.0:8080       0.0.0.0:*   
```

- **Recv-Q (Accept Queue, Backlog Queue)** → Number of connections waiting in the backlog.
- **Send-Q (Not relevant here)** → Usually for outbound data.

#### **Checking Kernel TCP Queues via** `**/proc/net/tcp**`

```
cat /proc/net/tcp
```

**Output:**

```
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:A253 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 35587 1 0000000053f53fa7 100 0 0 10 0
```

- **tx_queue** → Data waiting to be sent.
- **rx_queue** → Data waiting to be read.

---

## The Role of the Kernel in TCP Connections

- The **Linux kernel manages the entire TCP stack**:
    
    - Handshaking, sequencing, retransmissions, timeouts.
    - Maintaining connection queues & buffering.
    - Interacting with the NIC for packet transmission.
        
- Applications **don’t deal with raw packets directly**—they only read/write to sockets, while the kernel handles the rest.
    

### Flow Diagram: TCP Connection Journey with Kernel Involvement

```
  Client (User Space)          Kernel (Server)           Application (User Space)
        |                           |                           |
        | 1. SYN                    |                           |
        |--------------------------->|                           |
        |                           |                           |
        |        2. SYN-ACK          |                           |
        |<---------------------------|                           |
        |                           |                           |
        | 3. ACK                     |                           |
        |--------------------------->|                           |
        |                           |  Connection Added to SYN Queue |
        |                           |----------------------------->|
        |                           |                           |
        |                           |  Connection Moved to Accept Queue |
        |                           |----------------------------->|
        |                           |                           |
        |                           |  Application Calls `accept()` |
        |                           |----------------------------->|
        |                           |                           |
        |                           |  Data Transfer Begins |
```

### Why Each Connection Needs a Separate FD

- When a server **listens** on a port, it creates a **listening socket FD**.
- When a client initiates a connection:
    1. The kernel **accepts** the connection using the **3-way handshake**.
    2. The kernel **creates a new socket structure** for this connection.
    3. The server application calls `accept()`, which **returns a new FD**.
### Why is a New FD Required?

- **Each TCP connection requires its own state:**    
    - Sequence numbers (to track packets in order)
    - Receive and send buffers
    - Connection state (e.g., established, closed)

- **Does the Communication Happen on the Same Port?**

	- **Yes**, all connections still **use the same local port** (the port used for listening for connection on the server side).
	- **But**, each accepted connection is **a unique socket with a different remote IP/port pair**.
	- The kernel **distinguishes connections by**:  
	    **(Local IP, Local Port) <--> (Remote IP, Remote Port)**.

-  **Think of it like this:**
	- The **listening socket is like a front desk** at a hotel.
	- Every guest (client) gets **their own room (new socket)**, but **the front desk (listening socket) stays the same**.

### Multiple Sockets on the Same Port (`SO_REUSEPORT`)

- **Allows multiple FDs bound to the same port.**
- Kernel **load-balances connections** across them.
- **Used in:** **Nginx, HAProxy**.
    
#### Example: Multi-Threaded Server with `SO_REUSEPORT`

```
int sock1 = socket(AF_INET, SOCK_STREAM, 0);
int sock2 = socket(AF_INET, SOCK_STREAM, 0);
setsockopt(sock1, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
setsockopt(sock2, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
bind(sock1, ...);
bind(sock2, ...);
listen(sock1, BACKLOG);
listen(sock2, BACKLOG);
```

---
# References

- https://chatgpt.com/c/67c414f3-4830-8013-a058-0fd2596e3c07
