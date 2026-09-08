import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { NodeEntity, NodeType, ProtonDriveClient, ValidationError } from '@protontech/drive-sdk';

import { getName } from '../../cli/node';

export type SyncTreeEntry = {
    key: string;
    relativePath: string;
    segments: string[];
    depth: number;
    kind: 'file' | 'directory';
    localPath?: string;
    remoteNode?: NodeEntity;
};

export type LocalDirectory = {
    path: string;
    device: number;
};

export type LocalDirectoryChild = {
    name: string;
    path: string;
    kind: 'file' | 'directory';
};

export async function openLocalDirectory(rootPath: string): Promise<LocalDirectory> {
    const root = path.resolve(rootPath);
    const stats = await lstat(root);
    if (!stats.isDirectory()) {
        throw new ValidationError(`Sync source must be a directory: ${rootPath}`);
    }
    return { path: root, device: stats.dev };
}

export async function readLocalDirectory(parentPath: string, rootDevice: number): Promise<LocalDirectoryChild[]> {
    const children = await readdir(parentPath, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    const result: LocalDirectoryChild[] = [];
    for (const child of children) {
        const childPath = path.join(parentPath, child.name);
        const childStats = await lstat(childPath);
        if (childStats.dev !== rootDevice) {
            throw new ValidationError(`Cannot traverse into a different file system (mount point): ${childPath}`);
        }
        if (!childStats.isFile() && !childStats.isDirectory()) {
            throw new ValidationError(`Sync source contains an unsupported entry: ${childPath}`);
        }
        result.push({ name: child.name, path: childPath, kind: childStats.isDirectory() ? 'directory' : 'file' });
    }
    return result;
}

export async function collectLocalTree(rootPath: string): Promise<SyncTreeEntry[]> {
    const root = await openLocalDirectory(rootPath);

    const entries: SyncTreeEntry[] = [];
    async function visit(parentPath: string, segments: string[]): Promise<void> {
        const children = await readLocalDirectory(parentPath, root.device);
        for (const child of children) {
            const childSegments = [...segments, child.name];
            const entry: SyncTreeEntry = {
                key: makeKey(childSegments),
                relativePath: childSegments.join('/'),
                segments: childSegments,
                depth: childSegments.length,
                kind: child.kind,
                localPath: child.path,
            };
            entries.push(entry);
            if (entry.kind === 'directory') {
                await visit(child.path, childSegments);
            }
        }
    }

    await visit(root.path, []);
    return entries;
}

export async function collectRemoteTree(sdk: ProtonDriveClient, rootNode: NodeEntity): Promise<SyncTreeEntry[]> {
    const entries: SyncTreeEntry[] = [];
    const stack: { node: NodeEntity; segments: string[] }[] = [{ node: rootNode, segments: [] }];

    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.node.type !== NodeType.Folder) {
            continue;
        }
        const children: NodeEntity[] = [];
        for await (const child of sdk.iterateFolderChildren(current.node)) {
            children.push(child);
        }
        for (const child of children.reverse()) {
            if (child.type !== NodeType.File && child.type !== NodeType.Folder) {
                throw new ValidationError(`Sync destination contains an unsupported node type: ${child.type}`);
            }
            const segments = [...current.segments, getName(child)];
            entries.push({
                key: makeKey(segments),
                relativePath: segments.join('/'),
                segments,
                depth: segments.length,
                kind: child.type === NodeType.Folder ? 'directory' : 'file',
                remoteNode: child,
            });
            if (child.type === NodeType.Folder) {
                stack.push({ node: child, segments });
            }
        }
    }
    return entries;
}

export function makeKey(segments: string[]): string {
    return segments.join('\0');
}
