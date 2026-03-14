const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WorkerPool } = require('./worker-pool');

class FakeWorker extends EventEmitter {
    static instances = [];

    // 0144_constructor_初始化实例逻辑
    constructor(file) {
        super();
        this.file = file;
        this.terminated = false;
        this.exited = false;
        FakeWorker.instances.push(this);
    }

    // 0145_postMessage_执行postMessage相关逻辑
    postMessage(message) {
        this.lastMessage = message;
    }

    // 0146_terminate_执行terminate相关逻辑
    terminate() {
        this.terminated = true;
        if (!this.exited) {
            this.exited = true;
            this.emit('exit', 0);
        }
        return Promise.resolve(0);
    }
}

// 0147_makePool_线程池逻辑
function makePool(size = 1, taskTimeoutMs = 60) {
    FakeWorker.instances = [];
    return new WorkerPool({
        size,
        taskTimeoutMs,
        workerFile: 'fake-worker.js',
        WorkerClass: FakeWorker,
        now: () => '2026-03-14T00:00:00.000Z',
    });
}

test('worker-pool constructor should cover defaults and no-op handlers', async () => {
    class BareWorker extends EventEmitter {
        // 0148_constructor_初始化实例逻辑
        constructor(file) {
            super();
            this.file = file;
        }
        postMessage() {}
        terminate() { return Promise.resolve(0); }
    }

    const pool = new WorkerPool({ size: 1, taskTimeoutMs: 30, WorkerClass: BareWorker });
    assert.equal(typeof pool.workerFile, 'string');
    assert.equal(typeof pool.getStatus().timestamp, 'string');

    pool.handleWorkerMessage(999, { taskId: 1, ok: true, result: {} });
    pool.handleWorkerMessage(1, { taskId: 999, ok: true, result: {} });
    pool.handleWorkerError(999, null);
    pool.handleWorkerExit(999, 0);

    await pool.close();
});

test('worker-pool should execute success and failure tasks', async () => {
    const pool = makePool(1);

    const p1 = pool.runTask('x', { a: 1 });
    const w1 = FakeWorker.instances[0];
    w1.emit('message', { taskId: w1.lastMessage.taskId, ok: true, result: { ok: true } });
    const r1 = await p1;
    assert.equal(r1.ok, true);

    const p2 = pool.runTask('y', { b: 2 });
    w1.emit('message', { taskId: w1.lastMessage.taskId, ok: false, error: 'bad-task' });
    await assert.rejects(() => p2, /bad-task/);

    const p3 = pool.runTask('z', { c: 3 });
    w1.emit('message', { taskId: w1.lastMessage.taskId, ok: false });
    await assert.rejects(() => p3, /worker-task-failed/);

    const status = pool.getStatus();
    assert.equal(status.completedTasks, 1);
    assert.equal(status.failedTasks, 2);

    await pool.close();
});

test('worker-pool should track worker error events', async () => {
    const pool = makePool(1);
    const w1 = FakeWorker.instances[0];

    w1.emit('error', new Error('boom'));
    w1.emit('error', null);
    const status = pool.getStatus();
    assert.equal(status.failedTasks, 2);
    assert.equal(status.workers[0].lastError, 'worker-error');

    await pool.close();
});

test('worker-pool should timeout long task and restart worker', async () => {
    const pool = makePool(1, 20);
    const beforeCount = FakeWorker.instances.length;

    const task = pool.runTask('timeout-task', {});
    await assert.rejects(() => task, /task-timeout/);

    await new Promise((r) => setTimeout(r, 30));
    const status = pool.getStatus();
    assert.equal(status.restartedWorkers >= 1, true);
    assert.equal(FakeWorker.instances.length > beforeCount, true);

    await pool.close();
});

test('worker-pool timeout callback should no-op when task already finished', async () => {
    const pool = makePool(1, 20);
    const w1 = FakeWorker.instances[0];
    const task = pool.runTask('fast-task', {});
    w1.emit('message', { taskId: w1.lastMessage.taskId, ok: true, result: { ok: true } });
    await task;

    await new Promise((r) => setTimeout(r, 30));
    const status = pool.getStatus();
    assert.equal(status.failedTasks, 0);

    await pool.close();
});

test('worker-pool should cover default WorkerClass and drain guards', async () => {
    const poolZero = new WorkerPool({ size: 0, taskTimeoutMs: 10 });
    assert.equal(poolZero.getStatus().workersTotal, 0);
    await poolZero.close();

    const pool = makePool(1, 20);
    const w1 = FakeWorker.instances[0];
    const p = pool.runTask('guard-task', {});
    const taskId = w1.lastMessage.taskId;
    const entry = pool.running.get(taskId);
    pool.running.delete(taskId);
    await new Promise((r) => setTimeout(r, 30));
    entry.resolve({ ok: true });
    await p;

    pool.disposed = true;
    pool.drain();
    assert.equal(pool.getStatus().queueSize, 0);
    await pool.close();
});

test('worker-pool should reject running task when worker exits', async () => {
    const pool = makePool(1, 200);
    const w1 = FakeWorker.instances[0];

    const task = pool.runTask('exit-task', {});
    w1.exited = true;
    w1.emit('exit', 9);

    await assert.rejects(() => task, /worker-exit-9/);

    await pool.close();
});

test('worker-pool close should reject queued and running tasks', async () => {
    const pool = makePool(1, 500);

    const running = pool.runTask('a', {});
    const queued = pool.runTask('b', {});

    await pool.close();

    await assert.rejects(() => running, /worker-pool-closing/);
    await assert.rejects(() => queued, /worker-pool-closing/);
    await assert.rejects(() => pool.runTask('c', {}), /worker-pool-disposed/);
});

test('worker-pool should emit status updates and support subscribe unsubscribe', async () => {
    const pool = makePool(1);
    let count = 0;

    const unsub = pool.subscribe(() => {
        count += 1;
    });

    const task = pool.runTask('x', {});
    const w1 = FakeWorker.instances[0];
    w1.emit('message', { taskId: w1.lastMessage.taskId, ok: true, result: { ok: true } });
    await task;

    unsub();
    pool.emitStatus();

    assert.equal(count > 0, true);

    await pool.close();
});
