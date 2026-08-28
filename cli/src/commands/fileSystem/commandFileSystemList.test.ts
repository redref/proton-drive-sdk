import { MemberRole, NodeEntity, NodeType } from '@protontech/drive-sdk';

import type { ActionArgs } from '../../cli/interface';
import { PathType } from '../../cli/paths';
import { CommandFileSystemList } from './commandFileSystemList';

jest.mock('../../cli', () => ({
    ...jest.requireActual('../../cli/formatters'),
    ...jest.requireActual('../../cli/node'),
    PathType: jest.requireActual('../../cli/paths').PathType,
}));

const author = { ok: true as const, value: 'author@example.test' };

function node(uid: string, name: string, type: NodeType): NodeEntity {
    return {
        uid,
        name: { ok: true, value: name },
        type,
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

async function* nodes(items: NodeEntity[]) {
    yield* items;
}

describe('CommandFileSystemList', () => {
    let log: jest.SpyInstance;

    beforeEach(() => {
        log = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        log.mockRestore();
    });

    it('walks folders even when a recursive list filters its displayed type', async () => {
        const root = node('root', 'root', NodeType.Folder);
        const folder = node('folder', 'folder', NodeType.Folder);
        const nestedFile = node('nested', 'nested.txt', NodeType.File);
        const siblingFile = node('sibling', 'sibling.txt', NodeType.File);
        const iterateFolderChildren = jest.fn((parent: NodeEntity) => {
            if (parent.uid === root.uid) {
                return nodes([folder, siblingFile]);
            }
            if (parent.uid === folder.uid) {
                return nodes([nestedFile]);
            }
            return nodes([]);
        });
        const getNode = jest.fn().mockResolvedValue(root);
        const command = new CommandFileSystemList();

        await command.action({
            sdk: { iterateFolderChildren },
            paths: {
                getPath: () => ({ type: PathType.MyFiles, fullPath: '/my-files/root' }),
                getNode,
            },
            args: ['/my-files/root'],
            options: { json: false, recursive: true, type: NodeType.File },
        } as unknown as ActionArgs);

        expect(getNode).toHaveBeenCalledWith('/my-files/root');
        expect(iterateFolderChildren).toHaveBeenCalledWith(folder);
        const output = log.mock.calls.map(([line]) => String(line)).join('\n');
        expect(output).toContain('nested.txt');
        expect(output).toContain('sibling.txt');
        expect(output).not.toContain('folder');
    });

    it('includes the remote path with every recursive JSON entry', async () => {
        const root = node('root', 'root', NodeType.Folder);
        const file = node('file', 'foo/bar.txt', NodeType.File);
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const command = new CommandFileSystemList();

        try {
            await command.action({
                sdk: { iterateFolderChildren: () => nodes([file]) },
                paths: {
                    getPath: () => ({ type: PathType.MyFiles, fullPath: '/my-files/root' }),
                    getNode: () => Promise.resolve(root),
                },
                args: ['/my-files/root'],
                options: { json: true, recursive: true, type: '' },
            } as unknown as ActionArgs);

            const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
            expect(JSON.parse(output)).toMatchObject([
                {
                    path: '/my-files/root/foo\\/bar.txt',
                    depth: 0,
                    node: { uid: 'file', type: NodeType.File },
                },
            ]);
        } finally {
            write.mockRestore();
        }
    });
});
