---
title: Files And Directories
date: 2025-02-23T20:41:00
tags:
  - Disk
  - OS
  - FileSystem
draft: false
type: post
---

# Files and directories

File systems virtualize persistent storage (e.g., hard drives, SSDs) into user-friendly files and directories, adding a third pillar to OS abstractions (processes for CPU, address spaces for memory).

## File Paths and System Calls
Files are organized in a **tree-like directory structure**, starting from the root (/). A file’s location is identified by its **pathname** (e.g., /home/user/file.txt). To interact with files, processes use **system calls**:
- **open(path, flags)**: Opens a file and returns a **file descriptor** (fd).
- **read(fd, buffer, size)**: Reads data from the file into a buffer using the fd.
- **write(fd, buffer, size)**: Writes data to the file via the fd.
- **close(fd)**: Closes the file, freeing the fd.

## File Descriptors
A **file descriptor** is a small integer, unique to each process, that identifies an open file. When a process calls open(), the operating system assigns it the next available fd (e.g., 3, 4, etc.). Every process starts with three default fds:
- **0**: Standard input (*stdin*)
- **1**: Standard output (*stdout*)
- **2**: Standard error (*stderr*)

## Quick Note: File Descriptors & Terminals
Every process starts with three standard file descriptors: 
- `0` (stdin), `1` (stdout), `2` (stderr). 
### Where They Point
By default they link to a terminal device (e.g., `/dev/pts/0` for Terminal 1, `/dev/pts/1` for Terminal 2). These are character devices with a major number (e.g., 136) for the tty driver and a unique minor number (e.g., 0 or 1) for each instance. 

**Command Output (Terminal 1)**: 
```bash
ls -l /proc/self/fd
lrwx------ 1 runner runner 64 Feb 23 11:47 0 -> /dev/pts/0
lrwx------ 1 runner runner 64 Feb 23 11:47 1 -> /dev/pts/0
lrwx------ 1 runner runner 64 Feb 23 11:47 2 -> /dev/pts/0
```

**Device Details**:
```bash
ls -l /dev/pts/0
crw--w---- 1 runner tty 136, 0 Feb 23 11:53 /dev/pts/0

~/workspace$ stat /dev/pts/0
File: /dev/pts/0
Size: 0           Blocks: 0          IO Block: 1024   character special file
Device: 0,1350  Inode: 3           Links: 1     Device type: 136,0
Access: (0620/crw--w----)  Uid: ( 1000/  runner)   Gid: (    5/     tty)
Access: 2025-02-23 12:13:52.419852946 +0000
Modify: 2025-02-23 12:13:52.419852946 +0000
Change: 2025-02-23 11:36:28.419852946 +0000
 Birth: -
```

### Versus a File
A regular file descriptor (e.g., for *test.txt)* points to a disk inode with data blocks, tied to a filesystem device (e.g., */dev/sda1*), not a driver.

**Example:**
```bash
ls -li test.txt
12345 -rw-r--r-- 1 runner runner 5 Feb 23 12:00 test.txt

~/workspace$ stat test.txt
  File: test.txt
  Size: 288         Blocks: 8          IO Block: 4096   regular file
Device: 0,375   Inode: 1111        Links: 1
Access: (0644/-rw-r--r--)  Uid: ( 1000/  runner)   Gid: ( 1000/  runner)
Access: 2025-02-23 11:40:57.014322027 +0000
Modify: 2025-02-23 11:41:41.800233516 +0000
Change: 2025-02-23 11:41:41.800233516 +0000
 Birth: 2025-02-23 11:40:57.014322027 +0000
```

### Fun Test
Redirected Terminal 1’s output to Terminal 2:
- **Command**:  `echo "Hello" > /dev/pts/1`
- **Result**: "Hello" appeared in Terminal 2 (/dev/pts/1, minor 1)!


## Open File Table

The **Open File Table (OFT)** is a system-wide structure in kernel memory that tracks all open files. Each entry in the OFT includes:
- The **current offset** (position for the next read/write).
- Permissions (e.g., read, write).
- A **reference count** (if multiple processes share the file).

Each process has its own array of file descriptors, where each fd maps to an entry in the OFT. For example, process A’s fd 3 and process B’s fd 4 might point to the same OFT entry if they’ve opened the same file.

Example: Showing entries of a PID in open file table
```bash
~/workspace$ lsof -p 113
COMMAND PID   USER  FD   TYPE DEVICE SIZE/OFF    NODE NAME
bash    113 runner cwd    DIR  0,375      394     256 /home/runner/workspace
bash    113 runner rtd    DIR 0,1324     4096 1562007 /
bash    113 runner   0u   CHR  136,0      0t0       3 /dev/pts/0
bash    113 runner   1u   CHR  136,0      0t0       3 /dev/pts/0
bash    113 runner   2u   CHR  136,0      0t0       3 /dev/pts/0
bash    113 runner 255u   CHR  136,0      0t0       3 /dev/pts/0
```

As you see above that the process had 0,1 and 2 FDs as well as FD for a directory as well.

### Reference counting in OFT
**Reference counting** is a technique used in operating systems to manage entries in the **Open File Table (OFT)**, which stores information about open files shared by processes or file descriptors.
#### How It Works
- Each OFT entry has a **reference count** that tracks how many file descriptors (from one or more processes) refer to it.
- When a file is opened, the reference count increases by 1.
- If the same file is reused (e.g., via fork() or dup()), the count increments without creating a new entry.
- When a file descriptor is closed (e.g., with close(fd)), the count decreases by 1.
- The OFT entry is **removed** only when the reference count reaches **0**, meaning no process is using it.
#### How It Helps Remove Entries
Reference counting ensures an OFT entry is deleted only when it’s no longer needed. For example, after a fork(), both parent and child processes share the same OFT entry (reference count = 2). Closing the file in one process lowers the count to 1, but the entry persists until the second process closes it, bringing the count to 0.
#### Why It’s Useful
This method efficiently manages shared file resources, preventing premature removal of file metadata (like the current offset) while any process still needs it.

## INode 

#### What is an Inode?
An inode (short for "index node") is a fundamental data structure in UNIX-based file systems. It stores essential metadata about a file, enabling the system to manage and locate files efficiently. Each file in the system is uniquely identified by its inode number (also called i-number). The metadata stored in an inode includes:

- **File size**: The total size of the file in bytes.
- **Permissions**: Access rights defining who can read, write, or execute the file.
- **Ownership**: User ID (UID) and group ID (GID) of the file's owner.
- **Timestamps**:  
    - Last access time (when the file was last read).
    - Last modification time (when the file's content was last changed).
    - Last status change time (when the file's metadata, like permissions, was last modified).
      
- **Pointers to data blocks**: Locations on disk where the file's actual content is stored.
  
The inode does not store the file's name or its content; these are managed separately. The inode's role is to provide a compact and efficient way to access a file's metadata. Each inode is stored in inode block in disk.
#### How the stat System Call Works
The stat system call is used to retrieve metadata about a file without accessing its actual content. It provides a way for programs to query information like file size, permissions, and timestamps. Here's how it works:

1. **Input**: The stat system call takes a file path as input.  
2. **Locate the inode**: The file system uses the file path to find the corresponding inode number. (Insert link to FS implemetation note here explaining how FS searches inode and data block from given file path)
3. **Retrieve metadata**: The inode is fetched from disk (or from a cache, if available, for faster access).
4. **Populate the struct stat buffer**: The metadata stored in the inode is copied into a struct stat buffer, which contains fields for file size, permissions, ownership, timestamps, and more.
5. **Return to the user**: The struct stat buffer is returned to the calling program, providing all the metadata for the file.
  
Because the stat system call only accesses the inode and not the file's content, it is a fast and efficient operation. This separation of metadata (stored in the inode) and content (stored in data blocks) allows the system to quickly retrieve file information without unnecessary disk I/O.


# Directories
 `ls -al` Output for Directories
```bash
total 152
drwxr-xr-x 1 runner runner   394 Feb 23 11:40 .
drwxrwxrwx 1 runner runner    46 Feb 23 11:36 ..
-rw-r--r-- 1 runner runner   174 Feb 15 11:31 .breakpoints
drwxr-xr-x 1 runner runner    34 Feb 15 11:32 .cache
drwxr-x--- 1 runner runner   260 Feb 15 11:31 .ccls-cache
-rw-r--r-- 1 runner runner  1564 Dec 21 11:44 common_threads.h
-rwxr-xr-x 1 runner runner 16128 Dec 21 11:54 deadlock
-rw-r--r-- 1 runner runner   647 Dec 21 11:51 deadlock.c
-rwxr-xr-x 1 runner runner 16160 Dec 21 11:57 deadlock-global
-rw-r--r-- 1 runner runner   748 Dec 21 11:57 deadlock-global.c
-rw-r--r-- 1 runner runner  6320 Feb 23 11:36 generated-icon.png
-rw-r--r-- 1 runner runner   429 Mar  8  2024 .gitignore
-rwxr-xr-x 1 runner runner 15984 Dec 21 11:51 main
-rw-r--r-- 1 runner runner   415 Dec 21 11:51 main.c
-rwxr-xr-x 1 runner runner 16816 Aug 16  2024 main-debug
-rw-r--r-- 1 runner runner   411 Dec 12  2023 Makefile
-rwxr-xr-x 1 runner runner 16136 Dec 14 11:04 mem
-rw-r--r-- 1 runner runner  1437 Aug 16  2024 .replit
-rw-r--r-- 1 runner runner   134 Feb 23 13:54 replit.nix
-rwxr-xr-x 1 runner runner 15936 Dec 21 11:59 signal
-rw-r--r-- 1 runner runner   329 Dec 21 11:59 signal.c
-rw-r--r-- 1 runner runner   288 Feb 23 11:41 test.txt
drwxr-xr-x 1 runner runner    42 Feb 15 11:32 wcat
```

Size of a directory only means storage needed to store each directory entry which basically comprise entry name and its inode number along with some other metdata
#### Directory Data Block Contents
The data blocks of a directory contain:
- **Directory entries**: Mapping of file/subdirectory names to their inode numbers.
- **Special entries**: . (current directory) and .. (parent directory).

#### Optimization for Small Directories
For small directories, some file systems store directory entries directly in the inode itself, avoiding separate data blocks. This optimization saves space and speeds up access.
#### Reading Directory Entries with System Calls
To programmatically read directory contents following sys calls are used:
- **opendir(path)**: Opens the directory.
- **readdir(dir)**: Reads one entry at a time (returns a struct `dirent` with name and inode number.
- **closedir(dir)**: Closes the directory.

#### Permission bits and their octal representation
**Format**: ls -l displays permissions as rwxr-xr-x:  
- First character: d (directory), - (file), or l (symlink).
- Next 9 bits: Three groups of rwx for **owner**, **group**, and **others**:  
    - r = read, w = write, x = execute (run for files, enter for directories).
##### Converting a Full 9-Bit Permission to Numeric (Octal) Representation
 **Example**: `rwxr-xr-x`
- **Breakdown**: Split into three groups (owner, group, others):  
    - **Owner**: `rwx`.
    - **Group**:` r-x`.
    - **Others**:` r-x`.

**Step-by-Step Conversion**
1. **Owner: rwx**:  
    - r = 1, w = 1, x = 1 → Binary: 111.
    - Decimal: 1×4 + 1×2 + 1×1 = 4 + 2 + 1 = 7.
2. **Group: r-x**:  
    - r = 1, w = 0, x = 1 → Binary: 101.  
    - Decimal: 1×4 + 0×2 + 1×1 = 4 + 1 = 5.
3. **Others: r-x**:  
    - r = 1, w = 0, x = 1 → Binary: 101.  
    - Decimal: 1×4 + 0×2 + 1×1 = 4 + 1 = 5.
    - 
**Final Octal Representation**
- Combine the three digits: 7 5 5.
- **Result**: rwxr-xr-x = 755.
_Quick Recall_: Split rwx into 3 groups, convert each to binary (1s/0s), sum (4, 2, 1), get octal (e.g., 755).

### Hard Links, Symbolic Links (Including Size), and File Deletion (Based on OSTEP PDF)

#### Hard Links and unlink
- **Definition**: A hard link (PDF p. 18-19) is an extra directory entry pointing to the same inode, created with `link(old, new).`. When a directory reference its parent directory (with `..`)  it increases hard link count by 1.
  For a new empty directory its hard count is always 2 since it is referred by itself (with `.`) and also referred by its parent's directory entry (with `..`)
- **With unlink**: Removes a name-to-inode link, decrements the inode’s **link count**. When count hits 0 (and no processes use it), the inode and data blocks are freed from disk.
#### Symbolic Links and Dangling References
- **Definition**: A symbolic (soft) link (PDF p. 20-21) is a distinct file storing a pathname to another file, created with` ln -s old new`.
- **Size**: Its size equals the length of the stored pathname (e.g., 4 bytes for "file", 15 bytes for "alongerfilename"; PDF p. 21).
- **How It Works**: References the path, not the inode directly; accessing it resolves the path.
- **Dangling Reference**: If the target is deleted (e.g., unlink file), the symbolic link persists but points to nothing, causing errors (e.g., "No such file or directory").


## Disk, Partition, Volume, File System Hierarchy, and Mounting 
#### Distinction and Hierarchy
- **Disk**: Physical storage device (e.g., hard drive, SSD) holding raw data blocks.
- **Partition**: A subdivided section of a disk (e.g., `/dev/sda1`), treated as a separate unit.
- **Volume**: A logical abstraction, often a partition or group of partitions, formatted with a file system (FS).
- **File System**: Software structure (e.g.,` ext3, AFS`) organizing data into files and directories on a volume.

_Hierarchy_: Disk → Partitions → Volumes → File Systems.
#### Mounting Process
- **Creation**: Use `mkfs` to format a partition with a file system (e.g., `mkfs -t ext3 /dev/sda1 `creates an empty FS).
- **Mounting**: The mount command (PDF p. 24) attaches a file system to the directory tree at a **mount point** (e.g., `mount -t ext3 /dev/sda1 /home/users`), making its contents accessible under that path.
  
#### Multiple File Systems on One Machine
- A single machine can host multiple file systems by mounting them at different points in the tree (PDF p. 26).
- **Example Output** (from `mount`):
```bash
/dev/sda1 on / type ext3 (rw) # Root FS
/dev/sda5 on /tmp type ext3 (rw) # Separate tmp FS  
AFS on /afs type afs (rw) # Distributed FS
```
- **How**: Each partition or volume gets its own FS type and mount point, unified under one tree (e.g., /).

_Quick Recall_: Disk splits into partitions; volumes get FS; mount glues them into a tree; multiple FS coexist at different paths.

# References

- https://pages.cs.wisc.edu/~remzi/OSTEP/file-intro.pdf
- https://grok.com/share/bGVnYWN5_47ab49d6-aa1d-4de1-9bbe-0d47332e12fe
- https://grok.com/share/bGVnYWN5_7db77c97-d33d-4543-9993-d5aa362c8b2b