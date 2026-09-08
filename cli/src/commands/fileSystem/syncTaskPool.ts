import { ValidationError } from '@protontech/drive-sdk';

export const DEFAULT_SYNC_CONCURRENCY = 5;
export const MAX_SYNC_TASKS = 20;

export class SyncTaskPool {
    private readonly pending: (() => Promise<void>)[] = [];
    private readonly running = new Set<Promise<void>>();

    constructor(
        private readonly concurrency: number,
        private readonly maxTasks: number = MAX_SYNC_TASKS,
    ) {}

    /** Returns false when the caller should execute the task inline for backpressure. */
    enqueue(task: () => Promise<void>): boolean {
        if (this.pending.length + this.running.size >= this.maxTasks) {
            return false;
        }
        this.pending.push(task);
        this.startPending();
        return true;
    }

    async drain(): Promise<void> {
        while (this.running.size > 0) {
            await Promise.race(this.running);
        }
    }

    private startPending(): void {
        while (this.running.size < this.concurrency && this.pending.length > 0) {
            const task = this.pending.shift()!;
            const promise = Promise.resolve().then(task).finally(() => {
                this.running.delete(promise);
                this.startPending();
            });
            this.running.add(promise);
        }
    }
}

export function parseSyncConcurrency(value: unknown): number {
    const parsed = Number(value ?? DEFAULT_SYNC_CONCURRENCY);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
        throw new ValidationError('Concurrency must be an integer between 1 and 20');
    }
    return parsed;
}
