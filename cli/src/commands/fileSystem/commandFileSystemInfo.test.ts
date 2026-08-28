import { MemberRole, NodeEntity, NodeType } from '@protontech/drive-sdk';

import type { ActionArgs } from '../../cli/interface';
import { PathType } from '../../cli/paths';
import { CommandFileSystemInfo } from './commandFileSystemInfo';

jest.mock('../../cli', () => ({
    ...jest.requireActual('../../cli/formatters'),
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

describe('CommandFileSystemInfo', () => {
    it('prints each recursive descendant with its remote path', async () => {
        const root = node('root', 'root', NodeType.Folder);
        const file = node('file', 'readme.md', NodeType.File);
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const command = new CommandFileSystemInfo();
        let output: string[];

        try {
            await command.action({
                sdk: { iterateFolderChildren: () => nodes([file]) },
                paths: {
                    getPath: () => ({ type: PathType.MyFiles, fullPath: '/my-files/root' }),
                    getNode: () => Promise.resolve(root),
                },
                args: ['/my-files/root'],
                options: { json: false, recursive: true },
            } as unknown as ActionArgs);
            output = log.mock.calls.map(([line]) => String(line));
        } finally {
            log.mockRestore();
        }

        expect(output!).toEqual([
            '/my-files/root',
            expect.stringContaining("uid: 'root'"),
            '/my-files/root/readme.md',
            expect.stringContaining("uid: 'file'"),
        ]);
    });
});
