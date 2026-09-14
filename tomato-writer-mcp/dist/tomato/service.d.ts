/** 番茄作家后台业务封装：小说列表、阅读数据、建草稿、发布章节。 */
import { TomatoClient } from "./client.js";
export interface NovelSummary {
    book_id: string;
    book_name: string;
    word_count?: number;
    read_count?: number;
    creation_status?: number;
    status?: number;
    [k: string]: unknown;
}
export interface DraftInfo {
    itemId: string;
    volumeId: string;
    volumeName: string;
}
export declare class NovelService {
    private readonly client;
    constructor(client: TomatoClient);
    /** 账号下所有小说。 */
    listNovels(): Promise<NovelSummary[]>;
    getNovel(bookId: string): Promise<NovelSummary | undefined>;
    /** 各章阅读/追读等明细。参数随平台演进，调用方应容错。 */
    getChapterStats(bookId: string): Promise<unknown>;
    /** 分卷列表。 */
    listVolumes(bookId: string): Promise<unknown>;
    /** 某一卷下的章节列表。 */
    listChapters(bookId: string, volumeId: string): Promise<unknown>;
    /** 新建空草稿，返回章节 item_id 及其默认所属分卷。 */
    newDraft(bookId: string): Promise<DraftInfo>;
    /**
     * 发布一章 = 建草稿 + 提交。timerTime 为 unix 秒（>0 即定时/预约发布），
     * 不传则立即发布。
     */
    publishChapter(opts: {
        bookId: string;
        title: string;
        content: string;
        timerTime?: number;
        volumeId?: string;
        volumeName?: string;
    }): Promise<{
        itemId: string;
        timed: boolean;
        timerTime?: number;
        data: unknown;
    }>;
}
/** 用 .env 鉴权构造服务实例。 */
export declare function createService(): NovelService;
/** 解析要操作的 book_id：显式参数 > 当前选中 > 账号第一本。 */
export declare function resolveBookId(svc: NovelService, explicit?: string): Promise<string>;
