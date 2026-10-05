import type { McpUiDownloadFileRequest } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ReadResourceResult } from '@modelcontextprotocol/client';

export type Download = { name: string; blob: Blob };
const limit = 16 * 1024 * 1024;

// Resource links are resolved only through the originating MCP server.
export async function appDownloads(contents: McpUiDownloadFileRequest['params']['contents'], read: (uri: string) => Promise<ReadResourceResult>): Promise<Download[]> {
  if (!contents.length || contents.length > 10) throw new Error('每次下载需为 1–10 个文件');
  const files: Download[] = []; let total = 0;
  for (const item of contents) {
    const resources = item.type === 'resource_link' ? (await read(item.uri)).contents : [item.resource];
    if (resources.length !== 1 || resources[0].uri !== (item.type === 'resource_link' ? item.uri : item.resource.uri)) throw new Error('下载资源地址不匹配');
    const resource = resources[0];
    let blob: Blob;
    if ('text' in resource) blob = new Blob([resource.text], { type: resource.mimeType || 'text/plain' });
    else {
      if (resource.blob.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(resource.blob)) throw new Error('下载文件过大或 Base64 无效');
      blob = new Blob([Uint8Array.from(atob(resource.blob), c => c.charCodeAt(0))], { type: resource.mimeType || 'application/octet-stream' });
    }
    total += blob.size;
    if (total > limit) throw new Error('每次下载总量不得超过 16 MiB');
    const raw = item.type === 'resource_link' ? item.name : resource.uri.split('/').at(-1) || 'download';
    const name = raw.replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'download';
    files.push({ name, blob });
  }
  return files;
}
