import { NodeEntity, NodeType, ProtonDriveClient } from '@protontech/drive-sdk';

import { getName } from '../../cli/node';
import { appendRemotePath } from '../../cli/paths';

export type RemoteTreeEntry = {
    path: string;
    depth: number;
    node: NodeEntity;
};

/**
 * Streams the descendants of a Drive folder in depth-first order.
 *
 * Each active iterator stays on the stack until its folder is exhausted, so
 * memory use grows with tree depth rather than with the number of descendants.
 */
export async function* iterateRemoteTree(
    sdk: ProtonDriveClient,
    rootNode: NodeEntity,
    rootPath: string,
): AsyncGenerator<RemoteTreeEntry> {
    const stack: {
        path: string;
        depth: number;
        iterator: AsyncIterator<NodeEntity>;
    }[] = [
        {
            path: rootPath,
            depth: 0,
            iterator: sdk.iterateFolderChildren(rootNode),
        },
    ];

    while (stack.length > 0) {
        const current = stack[stack.length - 1]!;
        const next = await current.iterator.next();
        if (next.done) {
            stack.pop();
            continue;
        }

        const node = next.value;
        const entry = {
            node,
            depth: current.depth,
            path: appendRemotePath(current.path, getName(node)),
        };
        yield entry;

        if (node.type === NodeType.Folder) {
            stack.push({
                path: entry.path,
                depth: entry.depth + 1,
                iterator: sdk.iterateFolderChildren(node),
            });
        }
    }
}
