// 待存文件槽位——按对话记一个"Owner刚发/刚回复、默认没存的文件"句柄。
// owner-skip 默认不存Owner的文件，但她说"存下来"时品品调 pinpin_save_file 工具，
// 工具据此槽位下载落盘——品品不必传任何 message_id。
// 内存态（重启即失，靠"Owner回复文件"实时重新派生）；无外部依赖，避免循环 import。

export interface PendingSaveFile {
  fileMessageId: string; // 文件那条消息的 message_id（下载资源用）
  fileKey: string;
  fileName: string;
}

const pending = new Map<string, PendingSaveFile>();

/** 记下某对话当前待存的文件（parseFile owner 分支 / 回复 owner 文件时写）。覆盖式：最近一个胜出。 */
export function setPendingSaveFile(chatId: string, file: PendingSaveFile): void {
  pending.set(chatId, file);
}

export function getPendingSaveFile(chatId: string): PendingSaveFile | undefined {
  return pending.get(chatId);
}

export function clearPendingSaveFile(chatId: string): void {
  pending.delete(chatId);
}
