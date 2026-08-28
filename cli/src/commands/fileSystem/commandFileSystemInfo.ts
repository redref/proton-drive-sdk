import { NodeEntity, NodeType, ProtonDriveClient, ValidationError } from '@protontech/drive-sdk';

import { type ActionArgs, type Command, formatReadableJson, Options, PathType, printIterable, printObject, sanitizeTerminalText } from '../../cli';
import { iterateRemoteTree } from './remoteTree';

export class CommandFileSystemInfo implements Command {
    group = 'filesystem';
    name = 'info';
    help = 'Shows full node metadata including latest revision details.';
    args = ['path'];
    options: Options = {
        recursive: {
            type: 'boolean',
            short: 'r',
            default: false,
            help: 'Show metadata for all descendants of a Drive folder.',
        },
    };

    async action({ sdk, paths, args: [pathString], options: { json, recursive } }: ActionArgs) {
        if (recursive) {
            await this.printDescendants(sdk, paths, pathString, json);
            return;
        }
        const node = await paths.getNode(pathString);
        printObject(node, json);
    }

    private async printDescendants(sdk: ProtonDriveClient, paths: ActionArgs['paths'], pathString: string, json: boolean) {
        const path = paths.getPath(pathString);
        const supportedTypes = [PathType.MyFiles, PathType.Devices, PathType.SharedWithMe];
        const isVirtualRoot =
            path.fullPath === `/${PathType.Devices}` || path.fullPath === `/${PathType.SharedWithMe}`;
        if (!supportedTypes.includes(path.type) || isVirtualRoot) {
            throw new ValidationError(`Recursive info is not supported for path "${pathString}"`);
        }

        const rootNode = await paths.getNode(pathString);
        if (rootNode.type !== NodeType.Folder) {
            throw new ValidationError('Recursive info requires a folder path');
        }

        await printIterable(
            this.iterateInfoEntries(sdk, rootNode, path.fullPath),
            json,
            (entry) => {
                console.log(sanitizeTerminalText(entry.path));
                console.log(formatReadableJson(entry.node));
            },
            (entry) => entry,
        );
    }

    private async *iterateInfoEntries(
        sdk: ProtonDriveClient,
        rootNode: NodeEntity,
        rootPath: string,
    ): AsyncGenerator<{ path: string; depth: number; node: NodeEntity }> {
        yield { path: rootPath, depth: 0, node: rootNode };
        for await (const entry of iterateRemoteTree(sdk, rootNode, rootPath)) {
            yield { ...entry, depth: entry.depth + 1 };
        }
    }
}
