import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ValidationError } from '@protontech/drive-sdk';

import { collectLocalTree } from './syncTree';

describe('collectLocalTree', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'proton-drive-sync-'));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('returns a deterministic tree of directories and regular files', async () => {
        await mkdir(path.join(root, 'folder'));
        await writeFile(path.join(root, 'folder', 'nested.txt'), 'nested');
        await writeFile(path.join(root, 'top.txt'), 'top');

        const entries = await collectLocalTree(root);

        expect(entries.map(({ relativePath, kind, depth }) => ({ relativePath, kind, depth }))).toEqual([
            { relativePath: 'folder', kind: 'directory', depth: 1 },
            { relativePath: 'folder/nested.txt', kind: 'file', depth: 2 },
            { relativePath: 'top.txt', kind: 'file', depth: 1 },
        ]);
    });

    it('rejects symlinks instead of following them outside the source tree', async () => {
        await symlink(root, path.join(root, 'loop'));

        await expect(collectLocalTree(root)).rejects.toBeInstanceOf(ValidationError);
    });
});
