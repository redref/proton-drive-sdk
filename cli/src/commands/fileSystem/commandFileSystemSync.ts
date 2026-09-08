import { NodeEntity, NodeType, ProtonDriveClient, ValidationError } from '@protontech/drive-sdk';

import { type ActionArgs, type Command, Options, PathType, printObject } from '../../cli';
import { sanitizeTerminalText } from '../../cli/formatters';
import { createUploadProgressCallback, getFileMetadata } from './commandFileSystemUpload';
import { getSha1 } from './digest';
import { getLocalFileMediaType } from './mediaType';
import { parseSyncConcurrency, SyncTaskPool } from './syncTaskPool';
import {
    collectLocalTree,
    collectRemoteTree,
    makeKey,
    openLocalDirectory,
    readLocalDirectory,
    type SyncTreeEntry,
} from './syncTree';
import { createTransferProgress, type TransferProgressInterface } from './transferProgress';
import { TransferSummary } from './transferSummary';

const SUPPORTED_REMOTE_PATH_TYPES = [PathType.MyFiles, PathType.Devices, PathType.SharedWithMe];

type DryRunOperation = {
    action: 'create-directory' | 'upload-file' | 'update-file' | 'skip-file' | 'trash' | 'delete';
    path: string;
};

type RemoteDeletionCandidate = {
    uid: string;
    relativePath: string;
};

export class CommandFileSystemSync implements Command {
    group = 'filesystem';
    name = 'sync';
    help = 'Synchronizes a local directory to a remote Drive folder. The local directory contents become the destination contents.';
    args = ['localDirectory', 'remoteDirectory'];
    options: Options = {
        trash: {
            type: 'boolean',
            default: true,
            help: 'Move remote entries absent from the local directory to trash after a successful sync.',
        },
        delete: {
            type: 'boolean',
            default: false,
            help: 'Permanently delete remote entries absent from the local directory after a successful sync.',
        },
        'skip-thumbnails': {
            type: 'boolean',
            short: 't',
            default: false,
            help: 'Skip generating thumbnails.',
        },
        'dry-run': {
            type: 'boolean',
            short: 'n',
            default: false,
            help: 'Show planned changes without modifying the remote folder.',
        },
        concurrency: {
            type: 'string',
            short: 'c',
            default: String(5),
            help: 'Maximum number of concurrent remote operations.',
        },
    };

    async action({ logger, sdk, paths, metrics, args: [localDirectory, remoteDirectory], options }: ActionArgs) {
        const {
            json,
            trash,
            delete: permanentlyDelete,
            'skip-thumbnails': skipThumbnails,
            'dry-run': dryRun,
            concurrency,
        } = options;
        if (trash && permanentlyDelete) {
            throw new ValidationError('Use either --trash or --delete, not both');
        }
        if (!localDirectory?.trim() || !remoteDirectory?.trim()) {
            throw new ValidationError('A local directory and a remote directory are required');
        }

        const localRoot = await openLocalDirectory(localDirectory);
        const taskPool = new SyncTaskPool(parseSyncConcurrency(concurrency));
        const destination = await this.resolveDestination(sdk, paths, remoteDirectory, dryRun);
        const remoteRoot = destination.node;

        if (dryRun) {
            const [localEntries, remoteEntries] = await Promise.all([
                collectLocalTree(localDirectory),
                destination.missing ? Promise.resolve([]) : collectRemoteTree(sdk, remoteRoot),
            ]);
            const localByKey = this.indexEntries(localEntries, 'source');
            const remoteByKey = this.indexEntries(remoteEntries, 'destination');
            this.validateTypes(localEntries, remoteByKey);
            await this.printDryRun(
                localEntries,
                remoteByKey,
                remoteEntries,
                localByKey,
                trash,
                permanentlyDelete,
                destination.missing,
                json,
            );
            return;
        }

        const summary = new TransferSummary('sync');
        const progress = json ? undefined : createTransferProgress(() => summary.formatProgressLine());
        const remoteDeletionCandidates = new Map<string, RemoteDeletionCandidate>();
        const taskFailure: { error?: unknown } = {};
        let fatalError: unknown;
        if (destination.missing) {
            this.printEvent(json, progress, '✓ Created folder: .');
        }

        try {
            await this.enqueueDirectory(
                { sdk, logger, metrics, json, progress, skipThumbnails, summary, remoteDeletionCandidates, taskPool, taskFailure },
                { relativePath: '.' } as SyncTreeEntry,
                () => this.syncDirectory(
                    { sdk, logger, metrics, json, progress, skipThumbnails, summary, remoteDeletionCandidates, taskPool, taskFailure },
                    localRoot.path,
                    localRoot.device,
                    remoteRoot,
                    [],
                ),
            );
            await taskPool.drain();
            if (taskFailure.error) {
                fatalError = taskFailure.error;
            } else if ((trash || permanentlyDelete) && summary.failureCount === 0) {
                await this.removeRemoteExtras(
                    sdk,
                    remoteDeletionCandidates.values(),
                    permanentlyDelete,
                    summary,
                    json,
                    progress,
                );
            }
        } catch (error) {
            await taskPool.drain();
            summary.recordFailure('.', error);
            this.printEvent(json, progress, `✗ Failed: . — ${formatError(error)}`);
            fatalError = error;
        } finally {
            progress?.dispose();
            summary.print({ json });
        }

        if (fatalError) {
            throw fatalError;
        }
        if (summary.failureCount > 0) {
            throw new ValidationError(`${summary.failureCount} item(s) failed to sync`);
        }
    }

    private indexEntries(entries: SyncTreeEntry[], location: string): Map<string, SyncTreeEntry> {
        const indexed = new Map<string, SyncTreeEntry>();
        for (const entry of entries) {
            if (indexed.has(entry.key)) {
                throw new ValidationError(`Ambiguous ${location} path: ${entry.relativePath}`);
            }
            indexed.set(entry.key, entry);
        }
        return indexed;
    }

    private async resolveDestination(
        sdk: ProtonDriveClient,
        paths: ActionArgs['paths'],
        remoteDirectory: string,
        dryRun: boolean,
    ): Promise<{ node: NodeEntity; missing: boolean }> {
        try {
            const node = await paths.getNode(remoteDirectory, SUPPORTED_REMOTE_PATH_TYPES);
            if (node.type !== NodeType.Folder) {
                throw new ValidationError('Sync destination must be a remote folder');
            }
            return { node, missing: false };
        } catch (error) {
            if (!(error instanceof ValidationError) || !error.message.startsWith('Node not found')) {
                throw error;
            }
        }

        const destinationPath = paths.getPath(remoteDirectory, SUPPORTED_REMOTE_PATH_TYPES);
        if (!destinationPath.name) {
            throw new ValidationError('Sync destination must be a remote folder');
        }
        const parent = await destinationPath.parentPath.getNode();
        if (parent.type !== NodeType.Folder) {
            throw new ValidationError('Sync destination parent must be a remote folder');
        }
        if (dryRun) {
            return { node: parent, missing: true };
        }
        return { node: await sdk.createFolder(parent, destinationPath.name), missing: true };
    }

    private validateTypes(localEntries: SyncTreeEntry[], remoteByKey: Map<string, SyncTreeEntry>): void {
        for (const local of localEntries) {
            const remote = remoteByKey.get(local.key);
            if (remote && local.kind !== remote.kind) {
                throw new ValidationError(`Type conflict at ${local.relativePath}: source is ${local.kind}, destination is ${remote.kind}`);
            }
        }
    }

    private async printDryRun(
        localEntries: SyncTreeEntry[],
        remoteByKey: Map<string, SyncTreeEntry>,
        remoteEntries: SyncTreeEntry[],
        localByKey: Map<string, SyncTreeEntry>,
        trash: boolean,
        permanentlyDelete: boolean,
        destinationMissing: boolean,
        json: boolean,
    ): Promise<void> {
        const operations: DryRunOperation[] = [];
        if (destinationMissing) {
            operations.push({ action: 'create-directory', path: '.' });
        }
        for (const entry of localEntries) {
            const remote = remoteByKey.get(entry.key)?.remoteNode;
            if (entry.kind === 'directory') {
                if (!remote) {
                    operations.push({ action: 'create-directory', path: entry.relativePath });
                }
                continue;
            }
            if (!entry.localPath) {
                throw new ValidationError(`Missing sync source for ${entry.relativePath}`);
            }
            const localSha1 = await getSha1(entry.localPath);
            if (remote?.activeRevision?.claimedDigests?.sha1 === localSha1) {
                operations.push({ action: 'skip-file', path: entry.relativePath });
            } else {
                operations.push({ action: remote ? 'update-file' : 'upload-file', path: entry.relativePath });
            }
        }
        if (trash || permanentlyDelete) {
            const action = permanentlyDelete ? 'delete' : 'trash';
            for (const entry of this.getRemoteExtraRoots(remoteEntries, localByKey)) {
                operations.push({ action, path: entry.relativePath });
            }
        }
        printObject({ dryRun: true, operations }, json);
    }

    private async syncFile(
        ctx: {
            sdk: ProtonDriveClient;
            logger: ActionArgs['logger'];
            metrics: ActionArgs['metrics'];
            json: boolean;
            progress: TransferProgressInterface | undefined;
            skipThumbnails: boolean;
            summary: TransferSummary;
        },
        entry: SyncTreeEntry,
        remoteNode: NodeEntity | undefined,
        parent: NodeEntity,
    ): Promise<void> {
        if (!entry.localPath) {
            throw new ValidationError(`Missing sync source or destination parent for ${entry.relativePath}`);
        }
        const { file, metadata, thumbnails } = await getFileMetadata(
            { logger: ctx.logger, skipThumbnails: ctx.skipThumbnails },
            { kind: 'file', localPath: entry.localPath, baseName: entry.segments.at(-1)!, parentNode: parent },
            getLocalFileMediaType(ctx.logger, entry.localPath),
        );
        if (remoteNode?.activeRevision?.claimedDigests?.sha1 === metadata.expectedSha1) {
            ctx.summary.recordSkip(entry.relativePath, remoteNode.uid);
            return;
        }

        const tracker = ctx.progress?.trackItem(entry.relativePath, file.size);
        try {
            const uploader = remoteNode
                ? await ctx.sdk.getFileRevisionUploader(remoteNode, metadata)
                : await ctx.sdk.getFileUploader(parent, entry.segments.at(-1)!, metadata);
            const controller = await uploader.uploadFromStream(
                file.stream(),
                thumbnails,
                createUploadProgressCallback(file.size, tracker),
            );
            await controller.completion();
            ctx.metrics?.reportUploadVerifierAttempt();
            ctx.summary.recordSuccess(file.size);
            this.printEvent(ctx.json, ctx.progress, `${remoteNode ? '↑ Updated' : '↑ Uploaded'}: ${entry.relativePath}`);
        } finally {
            tracker?.onFinished();
        }
    }

    private async syncDirectory(
        ctx: {
            sdk: ProtonDriveClient;
            logger: ActionArgs['logger'];
            metrics: ActionArgs['metrics'];
            json: boolean;
            progress: TransferProgressInterface | undefined;
            skipThumbnails: boolean;
            summary: TransferSummary;
            remoteDeletionCandidates: Map<string, RemoteDeletionCandidate>;
            taskPool: SyncTaskPool;
            taskFailure: { error?: unknown };
        },
        localDirectory: string,
        localDevice: number,
        remoteDirectory: NodeEntity,
        segments: string[],
    ): Promise<void> {
        const localChildren = new Map((await readLocalDirectory(localDirectory, localDevice)).map((child) => [child.name, child]));
        const remoteNames = new Set<string>();

        for await (const remoteNode of ctx.sdk.iterateFolderChildren(remoteDirectory)) {
            if (remoteNode.type !== NodeType.File && remoteNode.type !== NodeType.Folder) {
                throw new ValidationError(`Sync destination contains an unsupported node type: ${remoteNode.type}`);
            }
            const name = remoteNode.name.ok ? remoteNode.name.value : remoteNode.uid;
            if (remoteNames.has(name)) {
                throw new ValidationError(`Ambiguous destination path: ${[...segments, name].join('/')}`);
            }
            remoteNames.add(name);

            const localChild = localChildren.get(name);
            const childSegments = [...segments, name];
            const relativePath = childSegments.join('/');
            if (!localChild) {
                ctx.remoteDeletionCandidates.set(makeKey(childSegments), {
                    uid: remoteNode.uid,
                    relativePath,
                });
                continue;
            }
            localChildren.delete(name);
            if (localChild.kind !== (remoteNode.type === NodeType.Folder ? 'directory' : 'file')) {
                throw new ValidationError(
                    `Type conflict at ${relativePath}: source is ${localChild.kind}, destination is ${remoteNode.type}`,
                );
            }

            const entry: SyncTreeEntry = {
                key: makeKey(childSegments),
                relativePath,
                segments: childSegments,
                depth: childSegments.length,
                kind: localChild.kind,
                localPath: localChild.path,
            };
            if (entry.kind === 'directory') {
                await this.enqueueDirectory(ctx, entry, () =>
                    this.syncDirectory(ctx, localChild.path, localDevice, remoteNode, childSegments),
                );
            } else {
                await this.enqueueFile(ctx, entry, remoteNode, remoteDirectory);
            }
        }

        for (const localChild of localChildren.values()) {
            const childSegments = [...segments, localChild.name];
            const entry: SyncTreeEntry = {
                key: makeKey(childSegments),
                relativePath: childSegments.join('/'),
                segments: childSegments,
                depth: childSegments.length,
                kind: localChild.kind,
                localPath: localChild.path,
            };
            if (entry.kind === 'directory') {
                await this.enqueueDirectory(ctx, entry, async () => {
                    const created = await ctx.sdk.createFolder(remoteDirectory, localChild.name);
                    ctx.summary.recordSuccess();
                    this.printEvent(ctx.json, ctx.progress, `✓ Created folder: ${entry.relativePath}`);
                    await this.syncDirectory(ctx, localChild.path, localDevice, created, childSegments);
                });
            } else {
                await this.enqueueFile(ctx, entry, undefined, remoteDirectory);
            }
        }
    }

    private async enqueueDirectory(
        ctx: Parameters<CommandFileSystemSync['syncDirectory']>[0],
        entry: SyncTreeEntry,
        task: () => Promise<void>,
    ): Promise<void> {
        const handled = async () => {
            try {
                await task();
            } catch (error) {
                ctx.summary.recordFailure(entry.relativePath, error);
                this.printEvent(ctx.json, ctx.progress, `✗ Failed: ${entry.relativePath} — ${formatError(error)}`);
                if (entry.relativePath === '.') {
                    ctx.taskFailure.error = error;
                }
            }
        };
        if (!ctx.taskPool.enqueue(handled)) {
            await handled();
        }
    }

    private async enqueueFile(
        ctx: Parameters<CommandFileSystemSync['syncDirectory']>[0],
        entry: SyncTreeEntry,
        remoteNode: NodeEntity | undefined,
        parent: NodeEntity,
    ): Promise<void> {
        const handled = async () => {
            try {
                await this.syncFile(ctx, entry, remoteNode, parent);
            } catch (error) {
                ctx.summary.recordFailure(entry.relativePath, error, remoteNode?.uid);
                this.printEvent(ctx.json, ctx.progress, `✗ Failed: ${entry.relativePath} — ${formatError(error)}`);
            }
        };
        if (!ctx.taskPool.enqueue(handled)) {
            await handled();
        }
    }

    private async removeRemoteExtras(
        sdk: ProtonDriveClient,
        remoteEntries: Iterable<RemoteDeletionCandidate>,
        permanentlyDelete: boolean,
        summary: TransferSummary,
        json: boolean,
        progress: TransferProgressInterface | undefined,
    ): Promise<void> {
        for (const entry of remoteEntries) {
            try {
                for await (const result of sdk.trashNodes([entry.uid])) {
                    if (!result.ok) {
                        throw result.error;
                    }
                }
                if (permanentlyDelete) {
                    for await (const result of sdk.deleteNodes([entry.uid])) {
                        if (!result.ok) {
                            throw result.error;
                        }
                    }
                }
                summary.recordSuccess();
                this.printEvent(json, progress, `${permanentlyDelete ? '✖ Deleted' : '🗑 Trashed'}: ${entry.relativePath}`);
            } catch (error) {
                summary.recordFailure(entry.relativePath, error, entry.uid);
                this.printEvent(json, progress, `✗ Failed: ${entry.relativePath} — ${formatError(error)}`);
            }
        }
    }

    private getRemoteExtraRoots(remoteEntries: SyncTreeEntry[], localByKey: Map<string, SyncTreeEntry>): SyncTreeEntry[] {
        const extraKeys = new Set(remoteEntries.filter((entry) => !localByKey.has(entry.key)).map((entry) => entry.key));
        return remoteEntries.filter(
            (entry) => extraKeys.has(entry.key) && !extraKeys.has(makeKey(entry.segments.slice(0, -1))),
        );
    }

    private printEvent(json: boolean, progress: TransferProgressInterface | undefined, message: string): void {
        if (json) {
            return;
        }
        progress?.pause();
        try {
            console.log(sanitizeTerminalText(message));
        } finally {
            progress?.resume();
        }
    }
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
