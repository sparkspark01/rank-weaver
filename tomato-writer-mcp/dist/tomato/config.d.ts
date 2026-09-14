/** 鉴权加载 + “当前操作的小说”状态持久化。 */
import type { TomatoAuth } from "./client.js";
export declare function loadAuth(): TomatoAuth;
/** 当前选中的 book_id：优先 state.json，其次 .env 默认值。 */
export declare function getCurrentBookId(): string | undefined;
export declare function setCurrentBookId(bookId: string): void;
