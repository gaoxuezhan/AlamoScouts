const path = require('node:path');
const workerThreads = require('node:worker_threads');
const { EventEmitter } = require('node:events');

class WorkerPool extends EventEmitter {
    constructor({ size, taskTimeoutMs, workerFile, WorkerClass, now }) {
        super();
        this.size = size;
        this.taskTimeoutMs = taskTimeoutMs;
        this.workerFile = workerFile || path.join(__dirname, 'worker.js');
        this.WorkerClass = WorkerClass || workerThreads.Worker;
        this.now = now || (() => new Date().toISOString());

        this.queue = [];
        this.workers = new Map();
        this.taskSeq = 1;
        this.running = new Map();
        this.completedTasks = 0;
        this.failedTasks = 0;
        this.restartedWorkers = 0;
        this.disposed = false;

        for (let i = 0; i < size; i += 1) {
            this.spawnWorker(i + 1);
        }
    }

    spawnWorker(workerId) {
        const worker = new this.WorkerClass(this.workerFile);
        const meta = {
            workerId,
            worker,
            state: 'idle',
            currentTaskId: null,
            processed: 0,
            failed: 0,
            restarted: 0,
            lastError: null,
            lastSeenAt: this.now(),
            timer: null,
        };

        this.workers.set(workerId, meta);

        worker.on('message', (msg) => this.handleWorkerMessage(workerId, msg));
        worker.on('error', (err) => this.handleWorkerError(workerId, err));
        worker.on('exit', (code) => this.handleWorkerExit(workerId, code));

        this.emitStatus();
        this.drain();
    }

    handleWorkerMessage(workerId, message) {
        const meta = this.workers.get(workerId);
        if (!meta) return;

        const entry = this.running.get(message.taskId);
        if (!entry) return;

        clearTimeout(meta.timer);
        meta.timer = null;
        meta.state = 'idle';
        meta.currentTaskId = null;
        meta.lastSeenAt = this.now();

        this.running.delete(message.taskId);

        if (message.ok) {
            meta.processed += 1;
            this.completedTasks += 1;
            entry.resolve(message.result);
        } else {
            meta.failed += 1;
            meta.lastError = message.error;
            this.failedTasks += 1;
            entry.reject(new Error(message.error || 'worker-task-failed'));
        }

        this.emitStatus();
        this.drain();
    }

    handleWorkerError(workerId, err) {
        const meta = this.workers.get(workerId);
        if (!meta) return;
        meta.lastError = err?.message || 'worker-error';
        meta.failed += 1;
        this.failedTasks += 1;
        this.emitStatus();
    }

    handleWorkerExit(workerId, code) {
        const meta = this.workers.get(workerId);
        if (!meta) return;

        if (meta.timer) {
            clearTimeout(meta.timer);
            meta.timer = null;
        }

        if (meta.currentTaskId && this.running.has(meta.currentTaskId)) {
            const entry = this.running.get(meta.currentTaskId);
            this.running.delete(meta.currentTaskId);
            entry.reject(new Error(`worker-exit-${code}`));
            this.failedTasks += 1;
        }

        this.workers.delete(workerId);
        this.emitStatus();

        if (!this.disposed) {
            this.restartedWorkers += 1;
            this.spawnWorker(workerId);
        }
    }

    runTask(type, payload) {
        if (this.disposed) {
            return Promise.reject(new Error('worker-pool-disposed'));
        }

        const taskId = this.taskSeq;
        this.taskSeq += 1;

        return new Promise((resolve, reject) => {
            this.queue.push({ taskId, type, payload, resolve, reject, enqueuedAt: Date.now() });
            this.emitStatus();
            this.drain();
        });
    }

    drain() {
        if (this.disposed) return;

        const idleWorkers = Array.from(this.workers.values()).filter((meta) => meta.state === 'idle');

        for (const meta of idleWorkers) {
            if (this.queue.length === 0) {
                break;
            }

            const task = this.queue.shift();
            meta.state = 'busy';
            meta.currentTaskId = task.taskId;
            meta.lastSeenAt = this.now();

            this.running.set(task.taskId, task);
            meta.timer = setTimeout(() => {
                if (!this.running.has(task.taskId)) return;
                this.running.delete(task.taskId);
                meta.state = 'idle';
                meta.currentTaskId = null;
                meta.failed += 1;
                meta.lastError = 'task-timeout';
                this.failedTasks += 1;
                task.reject(new Error('task-timeout'));

                meta.worker.terminate().catch(() => {});
                this.emitStatus();
            }, this.taskTimeoutMs);

            meta.worker.postMessage({
                taskId: task.taskId,
                type: task.type,
                payload: task.payload,
            });
        }

        this.emitStatus();
    }

    getStatus() {
        const workers = Array.from(this.workers.values()).map((meta) => ({
            workerId: meta.workerId,
            state: meta.state,
            currentTaskId: meta.currentTaskId,
            processed: meta.processed,
            failed: meta.failed,
            lastError: meta.lastError,
            lastSeenAt: meta.lastSeenAt,
        }));

        const busyWorkers = workers.filter((item) => item.state === 'busy').length;

        return {
            timestamp: this.now(),
            workersTotal: workers.length,
            workersBusy: busyWorkers,
            queueSize: this.queue.length,
            runningTasks: this.running.size,
            completedTasks: this.completedTasks,
            failedTasks: this.failedTasks,
            restartedWorkers: this.restartedWorkers,
            workers,
        };
    }

    emitStatus() {
        this.emit('status', this.getStatus());
    }

    subscribe(handler) {
        this.on('status', handler);
        return () => this.off('status', handler);
    }

    async close() {
        this.disposed = true;

        for (const task of this.queue) {
            task.reject(new Error('worker-pool-closing'));
        }
        this.queue = [];

        for (const [taskId, task] of this.running.entries()) {
            this.running.delete(taskId);
            task.reject(new Error('worker-pool-closing'));
        }

        await Promise.allSettled(Array.from(this.workers.values()).map((meta) => meta.worker.terminate()));
        this.workers.clear();
        this.emitStatus();
    }
}

module.exports = {
    WorkerPool,
};
