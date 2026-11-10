import { copyFile } from 'node:fs/promises';
await copyFile(
  'src/server/acp-mcp-bridge.mjs',
  'dist/server/server/acp-mcp-bridge.mjs',
);
