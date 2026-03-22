const path = require('node:path');
const workerThreads = require('node:worker_threads');
const { EventEmitter } = require('node:events');

class WorkerPool extends EventEmitter {
    // 0133_constructor_初始化实例逻辑
    constructor({ size, taskTimeoutMs, workerFile, WorkerClass, now }) {
        super();
        this.size = size;
        this.taskTimeoutMs = taskTimeoutMs;
        this.workerFile = workerFile || path.join(__dirname, 'worker.js');
        this.WorkerClass = WorkerClass || workerThreads.Worker;
        this.now = now || (() => new Date().toISOString());

        this.targetSize = Math.max(0, Number.isFinite(Number(size)) ? Math.floor(Number(size)) : 0);
        this.nextWorkerId = 0;
        this.queue = [];
        this.workers = new Map();
        this.taskSeq = 1;
        this.running = new Map();
        this.completedTasks = 0;
        this.failedTasks = 0;
        this.restartedWorkers = 0;
        this.restartReasonCounts = {
            timeout: 0,
            connect_error: 0,
            protocol_error: 0,
            unknown: 0,
        };
        this.pendingRestartReasons = new Map();
        this.retiringWorkers = new Set();
        this.disposed = false;

        for (let i = 0; i < this.targetSize; i += 1) {
            this.spawnWorker();
        }
    }

    // 0150_allocateWorkerId_分配工作线程ID逻辑
    allocateWorkerId() {
        this.nextWorkerId += 1;
        return this.nextWorkerId;
    }

    // 0151_classifyRestartReason_分类重启原因逻辑
    classifyRestartReason(reason) {
        const text = String(reason || '').toLowerCase();
        if (!text) return 'unknown';
        if (text.includes('timeout')) return 'timeout';
        if (
            text.includes('connect')
            || text.includes('econn')
            || text.includes('enotfound')
            || text.includes('ehost')
            || text.includes('network')
            || text.includes('socket')
            || text.includes('http-')
        ) {
            return 'connect_error';
        }
        if (
            text.includes('protocol')
            || text.includes('invalid')
            || text.includes('parse')
            || text.includes('unknown-task-type')
        ) {
            return 'protocol_error';
        }
        return 'unknown';
    }

    // 0152_recordRestartReason_记录重启原因逻辑
    recordRestartReason(reason) {
        const code = this.classifyRestartReason(reason);
        this.restartReasonCounts[code] = (this.restartReasonCounts[code] || 0) + 1;
        return code;
    }

    // 0153_setPendingRestartReason_设置待消费重启原因逻辑
    setPendingRestartReason(workerId, reason) {
        if (!this.workers.has(workerId)) return;
        this.pendingRestartReasons.set(workerId, this.classifyRestartReason(reason));
    }

    // 0154_consumePendingRestartReason_消费待消费重启原因逻辑
    consumePendingRestartReason(workerId, fallback = 'unknown') {
        const pending = this.pendingRestartReasons.get(workerId);
        this.pendingRestartReasons.delete(workerId);
        return pending || this.classifyRestartReason(fallback);
    }

    // 0155_terminateWorkerMeta_终止工作线程元信息逻辑
    terminateWorkerMeta(meta) {
        if (!meta || !meta.worker) return;
        meta.worker.terminate().catch(() => {});
    }

    // 0156_enforceTargetSize_保持目标并发逻辑
    enforceTargetSize() {
        if (this.disposed) return;

        while (this.workers.size < this.targetSize) {
            this.spawnWorker();
        }

        const needRetire = this.workers.size - this.targetSize;
        if (needRetire <= 0) return;

        let marked = 0;
        const metas = Array.from(this.workers.values()).sort((a, b) => b.workerId - a.workerId);
        for (const meta of metas) {
            if (marked >= needRetire) break;
            if (this.retiringWorkers.has(meta.workerId)) continue;
            this.retiringWorkers.add(meta.workerId);
            marked += 1;
            if (meta.state === 'idle') {
                this.terminateWorkerMeta(meta);
            }
        }
    }

    // 0157_setSize_动态调整并发逻辑
    setSize(nextSize) {
        const normalized = Math.max(
            0,
            Number.isFinite(Number(nextSize)) ? Math.floor(Number(nextSize)) : this.targetSize,
        );
        this.targetSize = normalized;
        this.size = normalized;
        this.enforceTargetSize();
        this.emitStatus();
        this.drain();
        return this.getStatus();
    }

    // 0134_spawnWorker_工作线程逻辑
    spawnWorker(workerId = this.allocateWorkerId()) {
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
        this.nextWorkerId = Math.max(this.nextWorkerId, workerId);

        worker.on('message', (msg) => this.handleWorkerMessage(workerId, msg));
        worker.on('error', (err) => this.handleWorkerError(workerId, err));
        worker.on('exit', (code) => this.handleWorkerExit(workerId, code));

        this.emitStatus();
        this.drain();
    }

    // 0135_handleWorkerMessage_处理工作线程逻辑
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

        if (this.retiringWorkers.has(workerId)) {
            this.terminateWorkerMeta(meta);
            this.emitStatus();
            return;
        }

        this.emitStatus();
        this.drain();
    }

    // 0136_handleWorkerError_处理工作线程逻辑
    handleWorkerError(workerId, err) {
        const meta = this.workers.get(workerId);
        if (!meta) return;
        meta.lastError = err?.message || 'worker-error';
        meta.failed += 1;
        this.failedTasks += 1;
        this.setPendingRestartReason(workerId, meta.lastError);
        this.emitStatus();
    }

    // 0137_handleWorkerExit_处理工作线程退出逻辑
    handleWorkerExit(workerId, code) {
        const meta = this.workers.get(workerId);
        if (!meta) return;

        if (meta.timer) {
            clearTimeout(meta.timer);
            meta.timer = null;
        }

        let pendingTaskExitReason = null;
        if (meta.currentTaskId && this.running.has(meta.currentTaskId)) {
            const entry = this.running.get(meta.currentTaskId);
            this.running.delete(meta.currentTaskId);
            pendingTaskExitReason = `worker-exit-${code}`;
            entry.reject(new Error(pendingTaskExitReason));
            this.failedTasks += 1;
        }

        const isRetiring = this.retiringWorkers.delete(workerId);
        const restartReason = this.consumePendingRestartReason(
            workerId,
            pendingTaskExitReason || (Number(code) !== 0 ? `worker-exit-${code}` : meta.lastError || 'unknown'),
        );

        this.workers.delete(workerId);
        this.emitStatus();

        if (!this.disposed && !isRetiring && this.workers.size < this.targetSize) {
            this.restartedWorkers += 1;
            this.recordRestartReason(restartReason);
            this.spawnWorker(workerId);
            return;
        }

        if (!this.disposed) {
            this.enforceTargetSize();
        }
    }

    // 0138_runTask_执行任务逻辑
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

    // 0139_drain_执行drain相关逻辑
    drain() {
        if (this.disposed) return;

        const idleWorkers = Array.from(this.workers.values()).filter((meta) => meta.state === 'idle');

        for (const meta of idleWorkers) {
            if (this.retiringWorkers.has(meta.workerId)) {
                this.terminateWorkerMeta(meta);
                continue;
            }

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
                this.setPendingRestartReason(meta.workerId, 'task-timeout');
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

    // 0140_getStatus_获取逻辑
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
            targetWorkers: this.targetSize,
            restartReasonCounts: {
                timeout: this.restartReasonCounts.timeout || 0,
                connect_error: this.restartReasonCounts.connect_error || 0,
                protocol_error: this.restartReasonCounts.protocol_error || 0,
                unknown: this.restartReasonCounts.unknown || 0,
            },
            workers,
        };
    }

    // 0141_emitStatus_发出逻辑
    emitStatus() {
        this.emit('status', this.getStatus());
    }

    // 0142_subscribe_订阅逻辑
    subscribe(handler) {
        this.on('status', handler);
        return () => this.off('status', handler);
    }

    // 0143_close_关闭逻辑
    async close() {
        this.disposed = true;
        this.targetSize = 0;
        this.retiringWorkers.clear();
        this.pendingRestartReasons.clear();

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
