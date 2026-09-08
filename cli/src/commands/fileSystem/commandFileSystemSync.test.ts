import { MemberRole, NodeEntity, NodeType, ValidationError } from '@protontech/drive-sdk';

import type { ActionArgs } from '../../cli/interface';
import { PathType } from '../../cli/paths';
import { getSha1 } from './digest';
import {
    collectLocalTree,
    collectRemoteTree,
    makeKey,
    openLocalDirectory,
    readLocalDirectory,
} from './syncTree';

jest.mock('../../cli', () => ({
    PathType: jest.requireActual('../../cli/paths').PathType,
    printObject: jest.fn(),
}));
jest.mock('./commandFileSystemUpload', () => ({
    createUploadProgressCallback: jest.fn(),
    getFileMetadata: jest.fn(),
}));
jest.mock('./digest', () => ({ getSha1: jest.fn() }));
jest.mock('./transferProgress', () => ({ createTransferProgress: jest.fn() }));
jest.mock('./syncTree', () => ({
    collectLocalTree: jest.fn(),
    collectRemoteTree: jest.fn(),
    makeKey: jest.requireActual('./syncTree').makeKey,
    openLocalDirectory: jest.fn(),
    readLocalDirectory: jest.fn(),
}));

import { printObject } from '../../cli';
import { CommandFileSystemSync } from './commandFileSystemSync';

const collectLocalTreeMock = collectLocalTree as jest.MockedFunction<typeof collectLocalTree>;
const collectRemoteTreeMock = collectRemoteTree as jest.MockedFunction<typeof collectRemoteTree>;
const openLocalDirectoryMock = openLocalDirectory as jest.MockedFunction<typeof openLocalDirectory>;
const readLocalDirectoryMock = readLocalDirectory as jest.MockedFunction<typeof readLocalDirectory>;
const getSha1Mock = getSha1 as jest.MockedFunction<typeof getSha1>;
const printObjectMock = printObject as jest.MockedFunction<typeof printObject>;

const author = { ok: true as const, value: 'author@example.test' };

function folder(uid: string): NodeEntity {
    return {
        uid,
        name: { ok: true, value: 'root' },
        type: NodeType.Folder,
        keyAuthor: author,
        nameAuthor: author,
        directRole: MemberRole.Inherited,
        ownedBy: {},
        isShared: false,
        isSharedByUrl: false,
        creationTime: new Date(0),
        modificationTime: new Date(0),
        treeEventScopeId: 'scope',
    };
}

describe('CommandFileSystemSync', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        openLocalDirectoryMock.mockResolvedValue({ path: '/tmp/source', device: 1 });
        readLocalDirectoryMock.mockResolvedValue([]);
    });

    it('dry-run reports its plan without mutating the remote folder', async () => {
        const root = folder('root');
        collectLocalTreeMock.mockResolvedValue([
            {
                key: makeKey(['new.txt']),
                relativePath: 'new.txt',
                segments: ['new.txt'],
                depth: 1,
                kind: 'file',
                localPath: '/tmp/new.txt',
            },
        ]);
        collectRemoteTreeMock.mockResolvedValue([]);
        getSha1Mock.mockResolvedValue('sha1');
        const sdk = {
            createFolder: jest.fn(),
            getFileUploader: jest.fn(),
            getFileRevisionUploader: jest.fn(),
            trashNodes: jest.fn(),
            deleteNodes: jest.fn(),
        };

        await new CommandFileSystemSync().action({
            logger: {} as ActionArgs['logger'],
            sdk,
            paths: { getNode: () => Promise.resolve(root) },
            args: ['/tmp/source', '/my-files/target'],
            options: { json: true, trash: false, delete: false, 'skip-thumbnails': false, 'dry-run': true },
        } as unknown as ActionArgs);

        expect(printObjectMock).toHaveBeenCalledWith(
            {
                dryRun: true,
                operations: [{ action: 'upload-file', path: 'new.txt' }],
            },
            true,
        );
        expect(sdk.createFolder).not.toHaveBeenCalled();
        expect(sdk.getFileUploader).not.toHaveBeenCalled();
        expect(sdk.trashNodes).not.toHaveBeenCalled();
        expect(sdk.deleteNodes).not.toHaveBeenCalled();
    });

    it('trashes only roots of remote-only subtrees', async () => {
        const root = folder('root');
        const obsoleteFolder = folder('obsolete-folder');
        const trashNodes = jest.fn(async function* (nodes: NodeEntity[]) {
            yield { uid: nodes[0]!.uid, ok: true as const };
        });
        const iterateFolderChildren = jest.fn(async function* (node: NodeEntity) {
            if (node.uid === root.uid) {
                yield obsoleteFolder;
            }
        });
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await new CommandFileSystemSync().action({
                logger: {} as ActionArgs['logger'],
                sdk: { iterateFolderChildren, trashNodes, deleteNodes: jest.fn() },
                paths: { getNode: () => Promise.resolve(root) },
                args: ['/tmp/source', '/my-files/target'],
                options: { json: true, trash: true, delete: false, 'skip-thumbnails': false, 'dry-run': false },
            } as unknown as ActionArgs);
        } finally {
            log.mockRestore();
        }

        expect(trashNodes).toHaveBeenCalledTimes(1);
        expect(trashNodes).toHaveBeenCalledWith([obsoleteFolder.uid]);
    });

    it('creates a missing destination folder under its existing parent', async () => {
        const parent = folder('parent');
        const destination = { ...folder('destination'), name: { ok: true as const, value: 'backup' } };
        collectLocalTreeMock.mockResolvedValue([]);
        collectRemoteTreeMock.mockResolvedValue([]);
        const createFolder = jest.fn().mockResolvedValue(destination);
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        let output: string[];

        try {
            await new CommandFileSystemSync().action({
                logger: {} as ActionArgs['logger'],
                sdk: { createFolder, iterateFolderChildren: async function* () {} },
                paths: {
                    getNode: () => Promise.reject(new ValidationError('Node not found: backup')),
                    getPath: () => ({
                        name: 'backup',
                        parentPath: { getNode: () => Promise.resolve(parent) },
                    }),
                },
                args: ['/tmp/source', '/my-files/backup'],
                options: { json: false, trash: false, delete: false, 'skip-thumbnails': false, 'dry-run': false },
            } as unknown as ActionArgs);
            output = log.mock.calls.map(([line]) => String(line));
        } finally {
            log.mockRestore();
        }

        expect(createFolder).toHaveBeenCalledWith(parent, 'backup');
        expect(collectRemoteTreeMock).not.toHaveBeenCalled();
        expect(output!).toContain('✓ Created folder: .');
    });

    it('rejects a file-versus-folder conflict before modifying the destination', async () => {
        const root = folder('root');
        readLocalDirectoryMock.mockResolvedValue([{ name: 'conflict', path: '/tmp/source/conflict', kind: 'directory' }]);
        const iterateFolderChildren = async function* () {
            yield { ...folder('conflict-file'), name: { ok: true as const, value: 'conflict' }, type: NodeType.File };
        };
        const sdk = { createFolder: jest.fn() };
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});

        try {
            await expect(
                new CommandFileSystemSync().action({
                    logger: {} as ActionArgs['logger'],
                    sdk: { ...sdk, iterateFolderChildren },
                    paths: { getNode: () => Promise.resolve(root) },
                    args: ['/tmp/source', '/my-files/target'],
                    options: { json: true, trash: false, delete: false, 'skip-thumbnails': false, 'dry-run': false },
                } as unknown as ActionArgs),
            ).rejects.toThrow('Type conflict at conflict');
        } finally {
            log.mockRestore();
        }

        expect(sdk.createFolder).not.toHaveBeenCalled();
    });
});
