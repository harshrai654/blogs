---
title: Map Reduce
draft: false
tags: 
type: post
date: 2025-05-31T12:49:54+0530
category: Distributed Systems
---
This article shares learnings from Google's influential MapReduce paper and explores the challenges encountered while implementing a simplified version. Our system uses multiple worker processes, running on a single machine and communicating via RPC, to mimic key aspects of a distributed environment.

# What is Map-Reduce
At its core, MapReduce is a programming model and an associated framework for processing and generating massive datasets using a parallel, distributed algorithm, typically on a cluster of computers. You might already be familiar with map and reduce operations from functional programming languages. For instance, in JavaScript, array.map() transforms each element of an array independently based on a mapper function, while array.reduce() iterates through an array, applying a reducer function to accumulate its elements into a single output value (e.g., a sum, or a new, aggregated object).

The MapReduce paradigm, brilliantly scales these fundamental concepts to tackle data processing challenges that are orders of magnitude larger than what a single machine can handle. The general flow typically involves several key stages:

1. Splitting: The vast input dataset is initially divided into smaller, independent chunks. Each chunk will be processed by a Map task.

2. Map Phase: A user-defined Map function is applied to each input chunk in parallel across many worker machines. The Map function takes an input pair (e.g., a document ID and its content) and produces a set of intermediate key/value pairs. For example, in a word count application, a Map function might take a line of text and output a key/value pair for each word, like (word, 1).

3. Shuffle and Sort Phase: This is a critical intermediate step. The framework gathers all intermediate key/value pairs produced by the Map tasks, sorts them by key, and groups together all values associated with the same intermediate key. This ensures that all occurrences of (word, 1) for a specific 'word' are brought to the same place for the next phase.

4. Reduce Phase: A user-defined Reduce function then processes the grouped data for each unique key, also in parallel. The Reduce function takes an intermediate key and a list of all values associated with that key. It iterates through these values to produce a final output, often zero or one output value. Continuing the word count example, the Reduce function for a given word would receive (word, [1, 1, 1, ...]) and sum these ones to produce the total count, e.g., (word, total_count).

This distributed approach is highly effective for several reasons:

- Scalability: It allows for **horizontal scaling**, you can process more data faster by simply adding more machines to your cluster.

- Parallelism: It inherently **parallelizes computation**, significantly speeding up processing times for large tasks.

- Fault Tolerance: The MapReduce framework is designed to handle **machine failures automatically by re-executing failed tasks**, which is crucial when working with large clusters where failures are common.

This model simplifies large-scale data processing by abstracting away the complexities of distributed programming, such as data distribution, parallelization, and fault tolerance, allowing developers to focus on the logic of their Map and Reduce functions.

## The MapReduce Execution Flow

To understand how MapReduce processes vast amounts of data, let's walk through the typical execution flow, as illustrated in the Google paper and its accompanying diagram (Figure 1 from the paper, shown below). This flow is orchestrated by a central Master (or Coordinator, as in our lab implementation) and executed by multiple Worker processes.

![Pasted image 20250531133544.png](/media/pasted-image-20250531133544.png)

Here's a breakdown of the key stages:

1.  **Initialization & Input Splitting (Diagram: User Program forks Master, Input files split)**:
	- The MapReduce library first divides the input files into `M` smaller, manageable pieces called splits (e.g., split 0 to split 4 in the diagram). Each split is typically `16-64MB`.
	- The User Program then starts multiple copies of the program on a cluster. One copy becomes the Master, and the others become Workers. Here the binary contains logic for master and worker.
	
2. **Task Assignment by Master (Diagram: Master assigns map/reduce to workers)**:
	- The Master is the central coordinator. It's responsible for assigning tasks to idle workers. There are M map tasks (one for each input split) and R reduce tasks (a number chosen by the user for the desired level of output parallelism).
	
3. **Map Phase -  Processing Input Splits (Diagram: worker (3) reads split, (4) local write)**:
	- A worker assigned a map task reads the content of its designated input split (e.g., split 2).
	- It parses key/value pairs from this input data. For each pair, it executes the user-defined Map function. The Map function emits intermediate key/value pairs.
	- These intermediate pairs are initially buffered in the worker's memory. Periodically, they are written to the worker's local disk.
	  Crucially, these locally written intermediate files are partitioned into R regions/files **(one region/file for each eventual reduce task)**. This is typically done using a partitioning function (e.g., **hash(intermediate_key) % R**).
	- The locations of these R partitioned files on the local disk (shown as *"Intermediate files (on local disks)"* in the diagram) are then reported back to the Master. The Master now knows where the intermediate data for each reduce task partition resides, spread across possibly many map workers.

4. **Reduce Phase - Aggregating Intermediate Data (Diagram: worker (5) remote read, (6) write output):**
	- Once the Master sees that map tasks are completing, it begins assigning reduce tasks to other **(or the same)** workers.
	- When a reduce worker is assigned a partition *(say, partition j out of R)*, the Master provides it with the locations of all the relevant intermediate files (i.e., the *j-th* region/file from all map workers that produced j-th intermediate file).
	- The reduce worker then performs remote reads from the local disks of the map workers to fetch this buffered intermediate data.
	- After retrieving all necessary intermediate data for its assigned partition, **the reduce worker sorts these key/value pairs by the intermediate key.** This groups all occurrences of the same key together. (If data is too large for memory, an external sort is used).
	- The worker then iterates through the sorted data. For each unique intermediate key, it calls the user-defined Reduce function, passing the key and the list of all associated intermediate values.
	- The output of the Reduce function is appended to a final output file for that specific reduce partition (e.g., output file 0, output file 1). There will be R such output files.
5. **Job Completion:**
	- When all M map tasks and R reduce tasks have successfully completed, the Master signals the original User Program.
	- The MapReduce call in the user code returns, and the results are available in the R output files.

Key Design Decisions:
- **Abstraction:** Developers focus on `Map` and `Reduce` logic, while the framework manages distributed complexities like data partitioning, parallel execution, and shuffling.
- **Inherent Fault Tolerance:** The system is designed for resilience against common failures:
	- The Master detects worker failures. If a worker assigned a map task fails, the task is re-assigned because its input split is durable.
	- More subtly, if a worker completes a map task (producing intermediate files on its local disk) but then fails before all necessary reduce tasks have read those intermediate files, those files are lost. The Master must then reschedule that original map task on another worker to regenerate its intermediate output. 
	- If a worker assigned a reduce task fails, that reduce task can be re-executed by another worker.
	- However, once a reduce task completes successfully and writes its final output (e.g., to mr-out-X), that output is considered final. The system aims to avoid re-executing successfully completed reduce tasks, relying on the durability of their output.

One important aspect to note is that intermediate files are stored on the local file system of the worker nodes that produce them. This design choice is deliberate: by keeping intermediate data local, the *system significantly reduces network bandwidth consumption and potential network congestion that would arise if all intermediate data had to be written to, and read from, a global file system.* However, this means that crashes in map worker nodes can result in the loss of their locally stored intermediate data, necessitating the re-execution of those map tasks.

In contrast, the final outputs of worker processes executing the reduce operation are typically written to a global, distributed file system (like GFS in Google's case). Once a reduce task successfully writes its output to this global system, it's considered durable and generally does not need to be re-executed, even if the worker that produced it later fails.

# Implementing MapReduce in Go: The Coordinator and Worker

The Go implementation translates the conceptual MapReduce master-worker architecture into two main programs: a Coordinator and multiple Worker processes, communicating via RPC. We'll explore the key parts of their implementation, starting with the Coordinator.

## The Coordinator ([mr/coordinator.go](https://github.com/harshrai654/6.5840/blob/lab0/src/mr/coordinator.go))

The Coordinator is the central manager of the MapReduce job. Its primary role is to distribute tasks to workers, track their progress, handle failures, and determine when the overall job is complete.

1. **Initialization (`MakeCoordinator`)**
   The `MakeCoordinator` function initializes the Coordinator's state. It's called by `main/mrcoordinator.go` with the input files and the number of reduce tasks (`nReduce`).

```go
// MakeCoordinator is called by main/mrcoordinator.go to create and initialize
// the coordinator for a MapReduce job.
// - files: A slice of input file paths for the map tasks.
// - nReduce: The desired number of reduce tasks.
func MakeCoordinator(files []string, nReduce int) *Coordinator {
	// Step 1: Initialize the list of ready Map tasks.
	// NewTaskList() creates a new instance of TaskList (wrapper around container/list).
	readyTaskList := NewTaskList() 

	// For each input file, a Map task is created.
	for index, file := range files {
		readyTaskList.AddTask(&Task{ // Task struct holds details for a single map or reduce operation.
			Filename: file,                     // Input file for this map task.
			Status:   StatusReady,              // Initial status: ready to be assigned.
			Type:     MapType,                  // Task type is Map.
			Id:       TaskId(fmt.Sprintf("m-%d", index)), // Unique ID for the map task (e.g., "m-0").
		})
	}

	// Step 2: Initialize the Coordinator struct with its core state variables.
	c := Coordinator{
		// --- Task Tracking ---
		// readyTasks: Holds tasks (initially all Map tasks, later Reduce tasks) that are
		//             waiting to be assigned to a worker.
		//             Managed by GetTask (removes) and ReportTask/checkWorkerStatus (adds back on failure).
		readyTasks:        *readyTaskList, 

		// runningTasks: A map from TaskId to *RunningTask. Tracks tasks currently assigned
		//               to one or more workers. A RunningTask includes the Task details and a
		//               list of WorkerIds processing it.
		//               Managed by GetTask (adds) and ReportTask/checkWorkerStatus (modifies/removes).
		runningTasks:      make(map[TaskId]*RunningTask),

		// successTasks: A map from TaskId to *Task. Stores tasks that have been successfully
		//               completed by a worker.
		//               Managed by ReportTask (adds on success).
		successTasks:      make(map[TaskId]*Task),

		// --- Job Parameters & Phase Control ---
		// nReduce: The target number of reduce partitions/tasks for the job.
		//          Used by Map workers to partition intermediate data and by the Coordinator
		//          to determine when all reduce tasks are done.
		nReduce:           nReduce,

		// nMap: The total number of map tasks, simply the count of input files.
		//       Used to determine when all map tasks are done.
		nMap:              len(files),

		// pendingMappers: A counter for map tasks that are not yet successfully completed.
		//                 Crucially used in GetTask to gate the start of Reduce tasks –
		//                 Reduce tasks cannot begin until pendingMappers is 0.
		//                 Decremented in ReportTask upon successful map task completion.
		pendingMappers:    len(files),

		// --- Intermediate Data Management ---
		// intermediateFiles: An IntermediateFileMap (map[string]map[WorkerId][]string).
		//                    This is vital: maps a partition key (string, for a reduce task)
		//                    to another map. This inner map links a WorkerId (of a map worker)
		//                    to a list of filenames (intermediate files produced by that map worker
		//                    for that specific partition key).
		//                    Populated in ReportTask when a Map task succeeds.
		//                    Read by GetTask to provide Reduce workers with their input locations.
		intermediateFiles: make(IntermediateFileMap),

		// --- Worker Tracking ---
		// workers: A map from WorkerId to *WorkerMetdata. Stores metadata about each worker
		//          that has interacted with the coordinator. WorkerMetdata includes:
		//          - lastHeartBeat: Time of the worker's last contact, used by checkWorkerStatus for timeouts.
		//          - runningTask: TaskId of the task currently assigned to this worker.
		//          - successfulTasks: A map of tasks this worker has completed (useful for debugging/optimizations, not strictly essential for basic fault tolerance in this lab's context if tasks are just re-run).
		//          Populated/updated in GetTask and ReportTask.
		workers:           make(map[WorkerId]*WorkerMetdata),

		// --- Coordinator Shutdown & Job Completion Signaling ---
		// finished: A boolean flag set to true when all map and reduce tasks are successfully
		//           completed (checked in ReportTask). Signals the main job is done.
		finished:          false,

		// done: A channel of empty structs (chan struct{}). Used to signal background goroutines
		//       (like checkWorkerStatus) to terminate gracefully when the job is `finished`.
		//       Closed in the Done() method.
		done:              make(chan struct{}),

		// shutdownSignaled: A boolean flag, true after `done` channel is closed. Prevents
		//                   multiple closures or redundant shutdown logic.
		shutdownSignaled:  false,

		// allGoroutinesDone: A boolean flag, true after `wg.Wait()` in `Done()` confirms all
		//                    background goroutines have exited.
		allGoroutinesDone: false,
		// wg (sync.WaitGroup): Used in conjunction with `done` to wait for background goroutines
		//                      to complete their cleanup before the Coordinator fully exits.
		//                      Incremented before launching a goroutine, Done called in goroutine's defer.
		//                      (wg is part of the Coordinator struct, initialized implicitly here)
	}

	fmt.Printf("Initialised ready tasklist of %d tasks\n", len(files))

	// Step 3: Start Services
	// Start the RPC server so the coordinator can listen for requests from workers.
	// This makes methods like GetTask and ReportTask callable by workers.
	c.server()

	// Step 4: Launch Background Health Checker Goroutine
	// This goroutine is responsible for fault tolerance, specifically detecting
	// and handling timed-out (presumed crashed) workers.
	c.wg.Add(1) // Increment WaitGroup counter before launching the goroutine.
	go func() {
		defer c.wg.Done() // Decrement counter when the goroutine exits.
		for {
			select {
			case <-c.done: // Listen for the shutdown signal from the main coordinator logic.
				fmt.Printf("[Coordinator Shutdown]: Closing worker health check background thread.\n")
				return // Exit the goroutine.
			default:
				// Periodically call checkWorkerStatus to handle unresponsive workers.
				c.checkWorkerStatus() 
				// WORKER_TIMEOUT_SECONDS is 10s, so this checks every 5s.
				time.Sleep(WORKER_TIMEOUT_SECONDS / 2) 
			}
		}
	}()

	return &c // Return the initialized Coordinator instance.
}
```

- Initially, `M` map tasks are created (one for each input file) and added to `readyTasks`.
-  Contrary to the paper we can only run reduce tasks only when all mapper tasks are finished as input for a reduce task may require intermediate file output(s) from more than one map task since a map task produces at max `R` intermediate partition files,  each designated to one reduce task and reduce workers needs to fetch these intermediate files from each of the mapper worker's local file system.
- An RPC server (`c.server()`) is started for worker communication, and a background `goroutine (checkWorkerStatus)` is launched for fault tolerance. All shared state within the Coordinator (e.g., task lists, worker metadata) must be protected by mutexes (as seen in its methods like `GetTask`, `ReportTask`) since the shared state can be accessed by multiple go routines handling RPC calls from various worker processed which may lead to race conditions.
- 

2. **Assigning Tasks to Workers (`GetTask` RPC Handler)**
   Workers call the `GetTask` RPC handler to request jobs *(either Map or Reduce tasks)* from the Coordinator.
```go
// An RPC handler to find next available task (map or reduce)
func (c *Coordinator) GetTask(args *GetTaskArgs, reply *GetTaskReply) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	workerMetadata, ok := c.workers[args.WorkerId]

	// Requesting worker already processing a task
	// Skip task assignment
	if ok && workerMetadata.runningTask != "" {
		fmt.Printf("[GetTask]: Worker %d already processing task %s, rejecting task assignment request.\n", args.WorkerId, workerMetadata.runningTask)
		return nil
	}

	if c.readyTasks.GetTaskCount() == 0 {
		// No tasks available
		// map reduce is complete if we also have len(runningTasks) == 0
		// Sending InvalidType task in such cases to worker
		reply.Task = Task{
			Type: InvalidType,
		}
		return nil
	}

	task := c.readyTasks.RemoveTask()

	// Skipping tasks that are possible retrials with an instance already completed and part of success set
	// It is possible that a task here already has a status of `StatusRunning` we are not skipping such tasks in ready queue
	// This will result in multiple instances of same task execution, This case is possible if previous worker processing the task
	// failed/crashed (timeout of not reporting reached) and we added another instance of the same task.
	// Even if two workers report completion of same task only one of them will remove the task from running queue and add it to
	// success set, Reporting by slower worker will be skipped.

	// Only assing a reduce task when we are sure there is no pending map task left
	// Since then reduce task will surely fail because of unavailabiltiy of intermeidate fiel data
	for task != nil {
		if task.Status == StatusSuccess || (task.Type == ReduceType && c.pendingMappers > 0) {
			if task.Status == StatusSuccess {
				fmt.Printf("[GetTask]: Skipping ready task %s since it is already successfully completed\n", task.Id)
			} else {
				fmt.Printf("[GetTask]: Skipping reduce task %s since there are %d pending mappers\n", task.Id, c.pendingMappers)
			}
			task = c.readyTasks.RemoveTask()
		} else {
			break
		}
	}

	// Either all tasks are completed (if len(runningTasks) == 0)
	// OR all tasks are currently being processed by some workers
	if task == nil {
		reply.Task = Task{
			Type: InvalidType,
		}
		fmt.Printf("[GetTask]: No task to assign to worker %d, # Tasks Running : %d, # Tasks Completed: %d\n", args.WorkerId, len(c.runningTasks), len(c.successTasks))
		return nil
	}

	fmt.Printf("[GetTask]: Found a task with id %s for worker %d. Current Task Status: %v\n", task.Id, args.WorkerId, task.Status)

	// Found a task with Status as either `StatusError` or `StatusReady` or `StatusRunning`
	// If task's status is: `StatusError`` -> Retrying failed task again
	// If task's status is `StatusReady` -> First Attempt of processing of task
	// If task's status is `StatusRunning` -> Retrying already running task due to delay from previous assigned worker
	task.Worker = args.WorkerId
	task.StartTime = time.Now()
	task.Status = StatusRunning
	reply.Task = *task

	if task.Type == ReduceType {
		// Add intermediate file locations collected from various map executions
		reply.IntermediateFiles = c.intermediateFiles[task.Filename]
	}

	reply.NR = c.nReduce

	// Update list of workers currently processing a taskId
	rt := c.runningTasks[task.Id]

	if rt == nil {
		c.runningTasks[task.Id] = &RunningTask{}
	}
	c.runningTasks[task.Id].task = task

	c.runningTasks[task.Id].workers = append(c.runningTasks[task.Id].workers, args.WorkerId)

	if workerMetadata != nil {
		workerMetadata.lastHeartBeat = time.Now()
		workerMetadata.runningTask = task.Id
	} else {
		c.workers[args.WorkerId] = &WorkerMetdata{
			lastHeartBeat:   time.Now(),
			runningTask:     task.Id,
			successfulTasks: make(map[TaskId]*TaskOutput),
		}
	}

	return nil
}
```
- As defined in the paper's step-2 of the execution flow this method is called by various workers to request task which are in `readyTasks`. 
- It deals with scenarios like workers already being busy, no tasks being available, or tasks being unsuitable for immediate assignment (e.g., reduce tasks when mappers are still active).
- If a valid task is found all necessary details to execute that task are populated in `GetTaskReply` struct. For Map tasks, it implicitly provides the input file (via task.Filename). For Reduce tasks, it explicitly provides the locations of all relevant intermediate files and the total number of reducers (NR).


3. **Handling Task Completion/Failure (`ReportTask` RPC Handler)**
	Workers call `ReportTask` to inform the coordinator about the outcome of their assigned task.

```go
func (c *Coordinator) ReportTask(args *ReportTaskArgs, reply *ReportTaskReply) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	reply.Status = true // optimistic reply

	taskSuccessInstance := c.successTasks[args.Task.Id]
	// ... (validation: check if task already completed, if worker owns task) ...

	// Reported task is already in success set.
	// Possibly retried after timeout by another worker
	// One of the worker complted the task.
	if taskSuccessInstance != nil {
		fmt.Printf("[ReportTask]: Task %s has already been completed by worker %d\n", taskSuccessInstance.Id, taskSuccessInstance.Worker)
		// ... (update worker metadata) ...
		return nil
	}
	
	// ... (check if worker lost ownership of the task) ...


	if args.Task.Status == StatusError {
		fmt.Printf("[ReportTask]: Task %s reported with status %v by worker %d\n", args.Task.Id, args.Task.Status, args.Task.Worker)
		// ... (disown worker from task) ...
		// If no other worker is processing this task, add it back to readyTasks
		if len(c.runningTasks[args.Task.Id].workers) == 0 {
			task := args.Task
			task.Worker = 0
			task.StartTime = time.Time{}
			task.Status = StatusReady
			c.readyTasks.AddTask(&task)
		}
		return nil
	}

	if args.Task.Status == StatusSuccess {
		switch args.Task.Type {
		case MapType:
			intermediateFiles := args.Task.Output
			fmt.Printf("[ReportTask]: Mapper Task %s completed successfully by worker %d, produced following intermediate files: %v\n", args.Task.Id, args.Task.Worker, intermediateFiles)

			for _, filename := range intermediateFiles {
				partitionKey := strings.Split(filename, "-")[4] // Assumes filename format like w-<workerId>/mr-m-<taskId>-<hash>
				paritionFiles, ok := c.intermediateFiles[partitionKey]
				if !ok || paritionFiles == nil {
					paritionFiles = make(map[WorkerId][]string)
				}
				paritionFiles[args.Task.Worker] = append(paritionFiles[args.Task.Worker], filename)
				c.intermediateFiles[partitionKey] = paritionFiles
			}
			// ... (update worker metadata, move task to successTasks, decrement pendingMappers) ...
			delete(c.runningTasks, args.Task.Id)
			c.successTasks[args.Task.Id] = &args.Task
			c.pendingMappers--

			if c.pendingMappers == 0 {
				fmt.Printf("\nAll map task ran successfully. Tasks Run Details: \n %v \n", c.successTasks)
				c.addReduceTasks() // Trigger creation of reduce tasks
			}
		case ReduceType:
			// ... (update worker metadata, move task to successTasks) ...
			delete(c.runningTasks, args.Task.Id)
			c.successTasks[args.Task.Id] = &args.Task

			if len(c.successTasks) == c.nMap+c.nReduce {
				fmt.Printf("\nAll reduce tasks ran successfully. Tasks Run Details: \n %v \n", c.successTasks)
				c.finished = true // Mark entire job as done
			}
		default:
			// ...
		}
		// ... (logging) ...
	}
	return nil
}

// ... (helper function addReduceTasks)
func (c *Coordinator) addReduceTasks() {
	index := 0
	for partition, v := range c.intermediateFiles { // Iterate over collected partitions
		task := Task{
			Status:   StatusReady,
			Type:     ReduceType,
			Id:       TaskId(fmt.Sprintf("r-%d", index)),
			Filename: partition, // Partition key becomes the 'filename' for the reduce task
		}
		if c.successTasks[task.Id] == nil { // Avoid re-adding if already processed (e.g. due to retries)
			c.readyTasks.AddTask(&task)
			fmt.Printf("Reduce Task with Id %s Added to ready queue (Intermediate partition %s with %d files)\n", task.Id, partition, len(v))
		}
		index++
	}
	c.nReduce = index // Update nReduce to actual number of partitions, good for robustness
}
```

- If a task is reported with `StatusError`, and it's the only instance of that task running, it's re-queued for a later attempt. This is a core part of fault tolerance.
-  *Processes Successful Map Tasks:*
	- Collects and organizes the locations of intermediate files (output of Map functions) based on their partition key. This information (`c.intermediateFiles`) is vital for the subsequent Reduce phase, as it tells Reduce workers where to fetch their input data. This aligns with step 4 of the paper's flow.
	- Decrements `pendingMappers`. When all mappers are done, it triggers `addReduceTasks`.
	- Once all Map tasks are complete, `addReduceTasks` is called. It iterates through all the unique partition keys derived from the intermediate files and creates one `Reduce` task for each, adding them to the `readyTasks` queue.
- *Processes Successful Reduce Tasks:*
	- Marks the reduce task as complete.
	- Checks if all Map and Reduce tasks for the entire job are finished. If so, it sets `c.finished = true`, signaling that the Coordinator can begin shutting down.
- By checking `c.successTasks` at the beginning, it avoids reprocessing reports for tasks already marked as successful, which helps in scenarios with duplicate or late messages.

4. **Fault Tolerance (`checkWorkerStatus`)**
	A background `goroutine` periodically checks for unresponsive workers.
	
```go
func (c *Coordinator) checkWorkerStatus() {
	c.mu.Lock()
	defer c.mu.Unlock()

	for workerId, metadata := range c.workers {
		lastHeartBeatDuration := time.Since(metadata.lastHeartBeat)

		if metadata.runningTask != "" && lastHeartBeatDuration >= WORKER_TIMEOUT_SECONDS {
			fmt.Printf("Worker %d have not reported in last %s\n", workerId, lastHeartBeatDuration)
			taskToRetry := make([]*Task, 0)
			
			runningTask := c.runningTasks[metadata.runningTask]
			if runningTask == nil {
				// This case should ideally not happen if state is consistent
				fmt.Printf("[checkWorkerStatus]: Local worker state shows worker %d running rask %s whereas global running tasks state does not show any worker for the same task.\n", workerId, metadata.runningTask)
				// Potentially clear worker's running task if inconsistent: metadata.runningTask = ""
				continue // or return, depending on desired error handling
			}

			taskToRetry = append(taskToRetry, runningTask.task)
			metadata.runningTask = "" // Worker is no longer considered running this task

			// Remove this worker from the list of workers for the task
			runningTask.workers = slices.DeleteFunc(runningTask.workers, func(w WorkerId) bool {
				return w == workerId
			})

			// If this was the only worker on this task, or if we want to aggressively reschedule
			// (The current code implies rescheduling if *any* assigned worker times out, which is fine for this lab)
			if len(taskToRetry) > 0 { // Will always be true if runningTask was not nil
				for _, task := range taskToRetry {
					fmt.Printf("[checkWorkerStatus]: Adding task %s of type %d with status %d back to the ready queue.\n", task.Id, task.Type, task.Status)
					
					// Reset task for retry
					task.Status = StatusReady
					task.Worker = 0 // Clear previous worker assignment
					task.Output = make([]string, 0) // Clear previous output

					c.readyTasks.AddTask(task)
				}
			}
		} 
		// ... (logging for active workers) ...
	}
}	
```

*Key Decisions Upon Detecting a Failed Worker:*
- **Identify the Affected Task:** The primary task to consider is `metadata.runningTask`, which the failed worker was supposed to be executing. The details of this task are retrieved from `c.runningTasks`.
- **Update Worker's State:** The failed worker's `metadata.runningTask` is cleared, indicating it's no longer considered to be working on that task by the coordinator.
- **Update Task's Worker List:** The failed `workerId` is removed from the `runningTaskEntry.workers` list, which tracks all workers assigned to that specific task ID.
- **Reset Task for Re-execution:** The affected taskInstanceToRetry undergoes several state changes:
	- Status is set back to `StatusReady`, making it available in the `c.readyTasks` queue.
	- `Worker` (assigned worker ID) is cleared.
	- `StartTime` is reset.
	- `Output` (list of output files) is cleared, as any partial output is now suspect or irrelevant.
- **Re-queue the Task:** The reset task is added back to `c.readyTasks.AddTask(task)`. This ensures another worker can pick it up.

*Handling Lost Intermediate Data (Implicitly via Task Re-execution):*
A critical aspect of fault tolerance in MapReduce, as highlighted by the paper, is managing the intermediate files produced by map tasks. These are typically stored on the local disks of the map workers. If a map worker completes its task successfully but then crashes before all relevant reduce tasks have consumed its intermediate output, those intermediate files are lost.
Our current `checkWorkerStatus` implementation primarily focuses on retrying the actively running task of a worker that times out.
```go
// In checkWorkerStatus, when a worker (workerId) times out:
// ...
runningTask := c.runningTasks[metadata.runningTask]
// ...
taskToRetry = append(taskToRetry, runningTask.task) // The currently running task is added for retry
metadata.runningTask = ""
// ... task is reset and added back to c.readyTasks ...
```
This handles cases where a worker fails mid-task. But what about its previously completed  map tasks whose outputs are now gone?

*The Challenge of Retrying Previously Successful Map Tasks*
One might initially think that upon a worker's crash, we should re-queue all map tasks that worker had successfully completed. The following (commented-out) snippet from an earlier version of `checkWorkerStatus` attempted this:
```go
// Original (commented-out) consideration for retrying all successful map tasks of a crashed worker:

// Adding successful map tasks of this worker for retrial
for taskId, _ := range metadata.successfulTasks {
	if c.successTasks[taskId] != nil && c.successTasks[taskId].Type == MapType {
		// If this task was indeed in the global success set and was a MapType:
		taskToRetry = append(taskToRetry, c.successTasks[taskId]) // Add it for retrial
		delete(c.successTasks, taskId) // Remove from global success set
		// CRITICAL: We would also need to increment c.pendingMappers here if it had been decremented
		 c.pendingMappers++ 
	}
}

// Tombstoning metadata of intermediate files produced by this worker
// From global state so that downstream reduce workers get to know about the failure.
// This would ideally cause reduce tasks that depend on this worker's output to fail
// or wait, and get re-added after the map tasks are re-run.
for _, v := range c.intermediateFiles {
	// Mark intermediate files from this worker (workerId) as unavailable/invalid.
	delete(v, workerId) // Or v[workerId] = nil if the structure supports it
}
```
When a map worker crashes after successfully writing its intermediate files, those files (on its local disk) are lost in a true distributed system. Our lab setup, where all workers share the host's filesystem, can sometimes mask this; a 'crashed' worker's files might still be accessible. This is a crucial difference from a production environment.
Simply re-queuing all successfully completed map tasks from a crashed worker can be inefficient:
- Performance Hit: It can lead to significant re-computation and potential test timeouts, especially if many map tasks were already done by a worker which crashed.
- Complexity: Managing `pendingMappers` and preventing reduce tasks from starting prematurely adds complexity if many map tasks are suddenly re-added.

*A More Targeted Optimization:*
A more refined approach is to only re-run a successful map task from a crashed worker if its specific output intermediate partitions are actually needed by currently pending (not yet completed) reduce tasks.

This involves:

1. Identifying which map tasks the crashed worker completed.

2. Determining if their output partitions are required by any active or future reduce tasks.

3. Only then, re-queueing those specific map tasks and invalidating their previous intermediate file locations.

This smarter retry avoids redundant work but increases coordinator complexity. For our lab, focusing on retrying the currently running task of a failed worker proved sufficient to pass the tests, partly due to the shared filesystem behaviour making the storage of intermediate files also in some sense to global filesystem

In essence, `checkWorkerStatus` implements the "timeout and retry" strategy. It ensures that work assigned to unresponsive workers is not indefinitely stalled and is eventually re-assigned, which is fundamental for making progress in a distributed system prone to failures.

5. **Job Completion (Done)**
	`main/mrcoordinator.go `periodically calls` Done()` to check if the entire job is finished.
	
```go
// main/mrcoordinator.go calls Done() periodically to find out
// if the entire job has finished.
func (c *Coordinator) Done() bool {
	c.mu.Lock()

	// If the job is marked as finished and we haven't started the shutdown sequence for goroutines yet
	if c.finished && !c.shutdownSignaled {
		fmt.Printf("[Coordinator Shutdown]: MR workflow completed. Signaling internal goroutines to stop.\n")
		close(c.done)             // Signal all listening goroutines
		c.shutdownSignaled = true // Mark that we've signaled them
	}

	// If we have signaled for shutdown, but haven't yet confirmed all goroutines are done
	if c.shutdownSignaled && !c.allGoroutinesDone {
		c.mu.Unlock()
		c.wg.Wait() // Wait for all goroutines (like the health checker) to call c.wg.Done()
		c.mu.Lock() 
		c.allGoroutinesDone = true
		fmt.Printf("[Coordinator Shutdown]: All internal goroutines have completed.\n")
	}

	isCompletelyDone := c.finished && c.allGoroutinesDone
	c.mu.Unlock()
	return isCompletelyDone
}
```

## The Worker ([mr/worker.go](https://github.com/harshrai654/6.5840/blob/lab0/src/mr/worker.go))

The Worker process is responsible for executing the actual Map and Reduce functions as directed by the Coordinator. Each worker operates independently, requesting tasks, performing them, and reporting back the results.
1. Worker's Main Loop (`Worker` function)
   The Worker function, called by `main/mrworker.go`, contains the main operational loop.
```go
var workerId WorkerId = WorkerId(os.Getpid()) // Unique ID for this worker process
var dirName string = fmt.Sprintf("w-%d", workerId) // Worker-specific directory for temp files

// ... (Log, ihash functions) ...

// main/mrworker.go calls this function.
func Worker(mapf func(string, string) []KeyValue,
	reducef func(string, []string) string) {
	Log("Started")

	// Create a worker-specific directory if it doesn't exist.
	// Used for storing temporary files before atomic rename.
	if _, err := os.Stat(dirName); os.IsNotExist(err) {
		err := os.Mkdir(dirName, 0755)
		// ... (error handling) ...
	}

	getTaskargs := GetTaskArgs{ // Prepare args for GetTask RPC
		WorkerId: workerId,
	}

	for { // Main loop: continuously ask for tasks
		getTaskReply := GetTaskReply{}
		Log("Fetching task from coordinator...")
		ok := call("Coordinator.GetTask", &getTaskargs, &getTaskReply)

		if ok { // Successfully contacted Coordinator
			task := &getTaskReply.Task
			nReduce := getTaskReply.NR // Number of reduce partitions

			switch task.Type {
			case MapType:
				Log(fmt.Sprintf("Assigned map job with task id: %s", task.Id))
				processMapTask(task, nReduce, mapf) // Execute the map task
			case ReduceType:
				Log(fmt.Sprintf("Assigned reduce job with task id: %s", task.Id))
				intermediateFiles := getTaskReply.IntermediateFiles // Get locations from Coordinator
				processReduceTask(task, intermediateFiles, reducef) // Execute reduce task
			default: // InvalidType or unknown
				Log("Invalid task recieved or no tasks available. Sleeping.")
			}

			// If a valid task was processed (not InvalidType), report its status
			if task.Type != InvalidType {
				reportTaskArgs := ReportTaskArgs{ Task: *task }
				reportTaskReply := ReportTaskReply{}
				ok = call("Coordinator.ReportTask", &reportTaskArgs, &reportTaskReply)
				if !ok || !reportTaskReply.Status {
					Log("Failed to report task or coordinator indicated an issue. Exiting.")
					// The lab hints that if a worker can't contact the coordinator,
					// it can assume the job is done and the coordinator has exited.
					removeLocalWorkerDirectory() // Clean up worker-specific directory
					return
				}
			}
			// Brief pause before asking for the next task.
			time.Sleep(WORKER_SLEEP_DURATION) // WORKER_SLEEP_DURATION is 2s
		} else { // Failed to contact Coordinator
			Log("Failed to call 'Coordinator.GetTask'! Coordinator not found or exited. Exiting worker.")
			// removeLocalWorkerDirectory() // Cleanup if needed, though not strictly required by lab on exit
			return // Exit the worker process
		}
	}
}
```

- *Core Logic:* Continuously polls the Coordinator for tasks (`Coordinator.GetTask`). Based on the task type (`MapType` or `ReduceType`), it calls the respective processing function. After processing, it reports the outcome to the Coordinator (`Coordinator.ReportTask`).
- *Exit Condition:* If communication with the Coordinator fails (e.g., `GetTask` RPC fails), the worker assumes the job is complete and the Coordinator has shut down, so the worker also exits. This is a simple shutdown mechanism compliant with the lab requirements.
- *Local Directory:* Each worker maintains a local directory (`dirName like w-workerId`) for its temporary files, ensuring isolation before final output naming.

2. Processing Map Tasks (`processMapTask`)
```go
// Processes map task by fetching `Filename` from Task
// Calls provided mapf function and stores intermediate files after
// paritioninng them based on `ihash` function
func processMapTask(task *Task, nReduce int, mapf func(string, string) []KeyValue) error {
	Log(fmt.Sprintf("Processing map task with id %s and file: %s", task.Id, task.Filename))

	file, err := os.Open(task.Filename) // Open the input split (file)
	// ... (error handling: set task.Status = StatusError, return) ...
	content, err := io.ReadAll(file) // Read the entire file content
	// ... (error handling: set task.Status = StatusError, return) ...
	file.Close()

	intermediate := mapf(task.Filename, string(content)) // Execute the user-defined map function

	// Group intermediate key-value pairs by partition
	buckets := make(map[int][]KeyValue)
	for _, kv := range intermediate {
		partition := ihash(kv.Key) % nReduce // Determine partition using ihash
		buckets[partition] = append(buckets[partition], kv)
	}

	task.Output = []string{} // Clear previous output, prepare for new output filenames

	// For each partition, sort and write to a temporary intermediate file
	for partition, kva := range buckets {
		// In-memory sort for this partition's KeyValue pairs.
		// The paper mentions external sort if data is too large, but here it's in-memory.
		sort.Sort(ByKey(kva)) 

		// Create a temporary file in the worker's specific directory.
		tempFile, err := os.CreateTemp(dirName, "mwt-*") // "mwt" for map worker temp
		// ... (error handling: set task.Status = StatusError, return) ...
		
		enc := json.NewEncoder(tempFile)
		for _, kv := range kva { // Write sorted KeyValue pairs to the temp file using JSON encoding
			err := enc.Encode(&kv)
			// ... (error handling: set task.Status = StatusError, tempFile.Close(), return) ...
		}
		tempFile.Close() // Close after writing

		// Atomically rename the temporary file to its final intermediate name.
		// Filename format: mr-<map_task_id>-<partition_number> (e.g., mr-m-0-1)
		// Stored within the worker's directory: w-<workerId>/mr-m-0-1
		intermediateFilename := filepath.Join(dirName, fmt.Sprintf("mr-%s-%d", task.Id, partition))
		err = os.Rename(tempFile.Name(), intermediateFilename)
		// ... (error handling: set task.Status = StatusError, return) ...
		
		task.Output = append(task.Output, intermediateFilename) // Add final filename to task's output list
	}

	task.Status = StatusSuccess // Mark task as successful
	return nil
}
```

- *Core Logic:* Reads the assigned input file, applies the user-defined `mapf`, partitions the output KeyValue pairs using `ihash() % nReduce`, sorts each partition's data *in memory*, and writes it to a uniquely named intermediate file within its local directory.
- *Intermediate Files:* Output filenames (e.g., `w-workerId/mr-mapTaskID-partitionID`) are collected in `task.Output`.
- *Atomic Rename:* Uses `os.Rename` to make intermediate files visible only once fully written, preventing partial reads by reducers. This is crucial for consistency, especially if crashes occur.
- *In-Memory Sort:* A simplification for the lab; a production system might use external sorting if intermediate data for a partition is too large for memory.

3. Processing Reduce Tasks (`processReduceTask`)
```go
func processReduceTask(task *Task, intermediateFiles map[WorkerId][]string, reducef func(string, []string) string) error {
	Log(fmt.Sprintf("Processing reduce task with id %s for partition key %s", task.Id, task.Filename))

	// Create a temporary output file in the worker's directory
	tempReduceFile, err := os.CreateTemp(dirName, "mwt-*") // "mwt" for map worker temp (could be "rwt")
	// ... (error handling: set task.Status = StatusError, return) ...
	defer tempReduceFile.Close() // Ensure temp file is closed

	var kva []KeyValue // To store all KeyValue pairs for this reduce partition

	// Gather all intermediate data for this reduce task's partition from various map workers.
	// `intermediateFiles` (map[WorkerId][]string) comes from the Coordinator,
	// mapping map worker IDs to the list of intermediate files they produced for *this specific partition*.
	for mapWorkerId, filesFromMapWorker := range intermediateFiles {
		for _, filename := range filesFromMapWorker {
			Log(fmt.Sprintf("Processing intermediate file %s from map worker %d", filename, mapWorkerId))
			intermediateFile, err := os.Open(filename)
			// ... (error handling: set task.Status = StatusError, return) ...
			
			dec := json.NewDecoder(intermediateFile)
			for { // Read all KeyValue pairs from this intermediate file
				var kv KeyValue
				if err := dec.Decode(&kv); err != nil {
					if err != io.EOF { // Handle actual decoding errors
						Log(fmt.Sprintf("Error decoding KV from intermediate file %s: %v", filename, err))
						task.Status = StatusError
						intermediateFile.Close()
						return err
					}
					break // EOF reached
				}
				kva = append(kva, kv)
			}
			intermediateFile.Close()
		}
	}

	// Sort all collected KeyValue pairs by key. This groups identical keys together.
	// This is Step 5 of the paper: "When a reduce worker has read all intermediate data,
	// it sorts it by the intermediate keys..."
	// Again, this is an in-memory sort of all data for this partition.
	sort.Sort(ByKey(kva))

	// Iterate over sorted data, apply reducef for each unique key
	i := 0
	for i < len(kva) {
		j := i + 1
		// Find all values for the current key kva[i].Key
		for j < len(kva) && kva[j].Key == kva[i].Key {
			j++
		}
		values := []string{}
		for k := i; k < j; k++ {
			values = append(values, kva[k].Value)
		}
		
		output := reducef(kva[i].Key, values) // Execute user-defined reduce function

		// Write output in the format "key value\n" to the temporary reduce file.
		// This matches main/mrsequential.go and the lab's expected output format.
		fmt.Fprintf(tempReduceFile, "%v %v\n", kva[i].Key, output)
		i = j // Move to the next unique key
	}

	// Atomically rename the temporary output file to its final name (e.g., mr-out-0).
	// The final output file is placed in the current directory (mr-tmp/ during tests),
	// not the worker-specific one, as it's global output.
	finalOutputFileName := fmt.Sprintf("mr-out-%s", task.Filename) // task.Filename is the partition key (e.g., "0", "1")
	err = os.Rename(tempReduceFile.Name(), finalOutputFileName)
	// ... (error handling: set task.Status = StatusError, return) ...

	task.Output = []string{finalOutputFileName} // Record final output filename
	task.Status = StatusSuccess
	return nil
}
```

- *Core Logic:* Gathers all intermediate `KeyValue` pairs for its assigned partition (identified by `task.Filename`) from the locations provided by the Coordinator (`intermediateFiles`). It then sorts all these `KeyValue` pairs together, groups them by unique key, applies the user-defined `reducef` for each key and its list of values, and writes the final output.
- *Data Aggregation*: Reads from multiple intermediate files *(potentially from different map workers)* that correspond to its specific partition.
- *Global Sort (for the partition):* All `KeyValue` pairs for the partition are sorted together in memory before reduction. This is essential for grouping values for the same key.
- *Final Output:* Writes output to a *temporary file and then atomically renames it to the final output file name (e.g., mr-out-X)*, which is placed in the main job directory (not the worker's specific temp directory).
- *In-Memory Sort:* Similar to map tasks, all data for a reduce partition is sorted in memory.

# Conclusion
Working on this MapReduce project taught me a lot about Go’s concurrency features, how to use RPC for process communication, and how the MapReduce framework organizes big data jobs. Most importantly, I learned to think about what can go wrong in distributed systems and how to handle failures gracefully. It’s been a great hands-on way to understand the real challenges behind large-scale data processing.
# References

- https://pdos.csail.mit.edu/6.824/labs/lab-mr.html
- https://pdos.csail.mit.edu/6.824/papers/mapreduce.pdf
- https://github.com/harshrai654/6.5840/tree/lab0/src




