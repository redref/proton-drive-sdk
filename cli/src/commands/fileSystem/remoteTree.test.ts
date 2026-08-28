import { MemberRole, NodeEntity, NodeType } from '@protontech/drive-sdk';

import { iterateRemoteTree } from './remoteTree';

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

describe('iterateRemoteTree', () => {
    it('streams descendants depth first and preserves escaped remote paths', async () => {
        const root = node('root', 'root', NodeType.Folder);
        const folder = node('folder', 'folder', NodeType.Folder);
        const nestedFile = node('nested', 'foo/bar.txt', NodeType.File);
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

        const entries = await Array.fromAsync(
            iterateRemoteTree({ iterateFolderChildren } as never, root, '/my-files/root'),
        );

        expect(entries.map(({ path, depth, node }) => ({ path, depth, uid: node.uid }))).toEqual([
            { path: '/my-files/root/folder', depth: 0, uid: 'folder' },
            { path: '/my-files/root/folder/foo\\/bar.txt', depth: 1, uid: 'nested' },
            { path: '/my-files/root/sibling.txt', depth: 0, uid: 'sibling' },
        ]);
        expect(iterateFolderChildren).toHaveBeenCalledWith(root);
        expect(iterateFolderChildren).toHaveBeenCalledWith(folder);
    });
});
