import { ValidationError } from '@protontech/drive-sdk';

import { parseSyncConcurrency, SyncTaskPool } from './syncTaskPool';

describe('SyncTaskPool', () => {
    it('never runs more tasks than its concurrency limit', async () => {
        const pool = new SyncTaskPool(2);
        const resolvers: (() => void)[] = [];
        let running = 0;
        let peak = 0;
        let completed = 0;

        for (let i = 0; i < 5; i++) {
            pool.enqueue(
                () =>
                    new Promise<void>((resolve) => {
                        running++;
                        peak = Math.max(peak, running);
                        resolvers.push(() => {
                            running--;
                            resolve();
                        });
                    }),
            );
        }

        await Promise.resolve();
        while (completed < 5) {
            if (resolvers.length === 0) {
                await Promise.resolve();
                continue;
            }
            resolvers.shift()!();
            completed++;
            await Promise.resolve();
        }
        await pool.drain();

        expect(peak).toBe(2);
        expect(running).toBe(0);
    });

    it('applies backpressure after twenty outstanding tasks', async () => {
        const pool = new SyncTaskPool(1, 2);
        let release: (() => void) | undefined;

        expect(
            pool.enqueue(
                () =>
                    new Promise<void>((resolve) => {
                        release = resolve;
                    }),
            ),
        ).toBe(true);
        expect(pool.enqueue(async () => {})).toBe(true);
        expect(pool.enqueue(async () => {})).toBe(false);

        await Promise.resolve();
        release!();
        await pool.drain();
    });
});

describe('parseSyncConcurrency', () => {
    it('defaults to five and rejects invalid limits', () => {
        expect(parseSyncConcurrency(undefined)).toBe(5);
        expect(() => parseSyncConcurrency('0')).toThrow(ValidationError);
        expect(() => parseSyncConcurrency('1.5')).toThrow(ValidationError);
        expect(() => parseSyncConcurrency('21')).toThrow(ValidationError);
    });
});
