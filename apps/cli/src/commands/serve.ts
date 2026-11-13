import { startServer } from '@dbmcp/server';

export async function serveCommand(options: { allowProd?: boolean; dir?: string }): Promise<void> {
  // stdio transport owns stdout: never print logs here, they would corrupt the protocol.
  await startServer({
    startDir: options.dir,
    allowProd: options.allowProd === true,
    version: '0.1.0',
  });
}
